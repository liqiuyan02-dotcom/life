/**
 * 个人工作台 — 云端后端
 * 依赖 express + pg（当设置了 DATABASE_URL 时使用 PostgreSQL 持久化，跨重启不丢数据）。
 * 未设置 DATABASE_URL 时回退到本地 JSON 文件（server/data/db.json），便于本地开发。
 * 认证：手机号 + 密码（crypto.scrypt 哈希），token 用 HMAC-SHA256 签名。
 * 同源部署：后端同时用 express.static 托管 public/index.html，前端 fetch('/api/...') 同源。
 *
 * 启动： node server.js
 * 存储后端优先级：CloudBase 云数据库 > PostgreSQL > 本地 JSON 文件
 *
 * 环境变量：
 *   PORT           监听端口（Render / CloudBase 会注入）
 *   SECRET        token 签名密钥
 *   DATABASE_URL   PostgreSQL 连接串（设置后启用持久化存储，推荐在 Render 上挂免费 Postgres）
 *   DATA_FILE     仅本地文件模式使用（默认 server/data/db.json）
 *   TCB_ENV_ID     腾讯云 CloudBase 环境 ID（国内部署用，设置后启用云数据库，优先级最高）
 *   TCB_COLL       CloudBase 集合名（默认 wb_bucket）
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'workbench-dev-secret-change-me';
const USE_PG = !!process.env.DATABASE_URL;
const BUILD_VERSION = '1.6.2';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

// ---------- PostgreSQL 连接（可选）----------
let pool = null;
if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    keepAlive: true,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (e) => console.error('[pg] unexpected error', e.message));
}

// 连接自愈：Render 免费 Postgres 在连接空闲后会被服务端关闭，pg 默认不自动重连，
// 首个 query 会抛 ECONNRESET / connection terminated 等瞬时错误。捕获这类错误后
// 直接重试同一连接池（pg 会自动重建断开的连接），避免「服务器繁忙」假死。
// 注意：不要 pool.end() 再 new Pool()，pg 在 end 后会拒绝复用并抛
// "Cannot use a pool after calling end on the pool"，让自愈反而失效。
const PG_TRANSIENT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|57P01|08006|08003|08004|connection terminated|server closed the connection|terminating connection|closed connection|Connection terminated/i;
async function pgRun(queryFn, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await queryFn(pool);
    } catch (e) {
      lastErr = e;
      if (attempt < retries && PG_TRANSIENT.test(e.message || '')) {
        console.error(`[pg] 瞬时连接错误，重试(${attempt + 1}):`, e.message);
        continue; // 重试：pg 连接池会自动新建被断开的连接
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---------- 腾讯云 CloudBase 云数据库（可选，国内部署时启用）----------
// 设置了 TCB_ENV_ID 时启用，优先级最高。为规避「单文档 16MB」上限，
// 这里不把整个库存进一个文档，而是拆成：账号表 1 个文档 + 每个用户 1 个文档。
const TCB_ENV = process.env.TCB_ENV_ID || process.env.TCB_ENV || '';
const TCB_COLL = process.env.TCB_COLL || 'wb_bucket';
const TCB_USERS_DOC = '__users__';
let tcbColl = null;
if (TCB_ENV) {
  try {
    const cloudbase = require('@cloudbase/node-sdk');
    const tcbApp = cloudbase.init({ env: TCB_ENV });
    tcbColl = tcbApp.database().collection(TCB_COLL);
    console.log(`[store] CloudBase ready (env=${TCB_ENV}, collection=${TCB_COLL})`);
  } catch (e) {
    console.error('[store] CloudBase init failed, fallback:', e.message);
    tcbColl = null;
  }
}

const app = express();
app.use(express.json({ limit: '5mb' }));

// 基础安全响应头（宽松 CSP：允许内联脚本/样式以兼容单文件应用，但限制资源来源）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'"
  );
  next();
});

// 允许跨域（前端与后端可能不同源，同源时此配置无害）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 数据层 ----------
const EMPTY_DB = () => ({ users: {}, data: {} });

async function loadDB() {
  if (tcbColl) {
    const db = EMPTY_DB();
    // 账号表
    const u = await tcbColl.doc(TCB_USERS_DOC).get();
    const uArr = (u && u.data) || [];
    const uRow = Array.isArray(uArr) ? uArr[0] : uArr;
    if (uRow && uRow.value) db.users = uRow.value;
    // 每个用户一个文档：拉全量（用户数很少，一次分页即可）
    let skip = 0;
    for (;;) {
      const page = await tcbColl.skip(skip).limit(100).get();
      const rows = (page && page.data) || [];
      for (const r of rows) {
        if (!r || r._id === TCB_USERS_DOC) continue;
        if (r.value) db.data[r._id] = r.value;
      }
      if (rows.length < 100) break;
      skip += rows.length;
      if (skip > 5000) break; // 安全阀，避免意外死循环
    }
    return db;
  }
  if (USE_PG) {
    const r = await pgRun((p) => p.query("SELECT value FROM kv WHERE key = 'db'"));
    if (r.rows.length) return r.rows[0].value;
    return EMPTY_DB();
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return EMPTY_DB();
  }
}

async function saveDB(db) {
  if (tcbColl) {
    await tcbColl.doc(TCB_USERS_DOC).set({ value: db.users || {} });
    const ids = Object.keys(db.data || {});
    for (const id of ids) {
      const payload = JSON.stringify(db.data[id]);
      if (payload.length > 14 * 1024 * 1024) {
        // 单文档上限 16MB，留 2MB 余量；超限通常是记账照片 base64 太多
        console.error(`[tcb] 用户 ${id} 数据 ${payload.length} 字节，逼近单文档 16MB 上限，建议把照片迁移到对象存储`);
      }
      await tcbColl.doc(id).set({ value: JSON.parse(payload) });
    }
    return;
  }
  if (USE_PG) {
    await pgRun((p) => p.query(
      "INSERT INTO kv (key, value) VALUES ('db', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify(db)]
    ));
    return;
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// 简单内存互斥锁：串行化「读-改-写」操作，避免多标签页并发写导致数据覆盖/丢失（单进程有效）
let _writeLock = Promise.resolve();
function withLock(fn) {
  const run = _writeLock.then(fn, fn);
  _writeLock = run.then(() => {}, () => {});
  return run;
}

function userBucket(db, uid) {
  if (!db.data[uid]) {
    db.data[uid] = {
      ledgers: [], transactions: [], habits: [], checkins: [],
      categories: [], notes: [], settlements: [], meta: {}
    };
  }
  return db.data[uid];
}

// ---------- 认证 ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}
function signToken(uid, phone) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ uid, phone, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  if (sig !== expected) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  req.uid = payload.uid;
  req.phone = payload.phone;
  next();
}

// ---------- 默认种子 ----------
const STORE_WHITELIST = ['ledgers', 'transactions', 'habits', 'checkins', 'categories', 'notes', 'settlements', 'diary'];
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function seedDefaults(db, userUid) {
  const b = userBucket(db, userUid);
  const created = { ledgers: [], habits: [], categories: [], notes: [] };
  if (b.ledgers.length === 0) {
    const l = { id: uid(), name: '日常账本', members: ['我'], color: 0, createdAt: new Date().toISOString() };
    b.ledgers.push(l); created.ledgers.push(l);
  }
  if (b.habits.length === 0) {
    const defaults = [
      { name: '喝水', icon: '💧', color: 0, recordType: 'number', unit: '杯', target: 8 },
      { name: '跑步', icon: '🏃', color: 1, recordType: 'both', unit: '公里', target: null },
      { name: '阅读', icon: '📚', color: 2, recordType: 'text', unit: '', target: null },
      { name: '拉屎', icon: '💩', color: 6, recordType: 'text', unit: '', target: null },
      { name: '奶茶', icon: '🧋', color: 3, recordType: 'number', unit: '杯', target: null },
      { name: '游泳课程', icon: '🏊', color: 4, recordType: 'both', unit: '课时', target: null },
      { name: '日常游泳', icon: '🏊', color: 5, recordType: 'both', unit: '分钟', target: null }
    ];
    for (const d of defaults) {
      const h = { id: uid(), ...d, createdAt: new Date().toISOString() };
      b.habits.push(h); created.habits.push(h);
    }
  }
  if (b.categories.length === 0) {
    const cats = [
      { name: '工作', color: 4 }, { name: '生活', color: 3 },
      { name: '想法', color: 2 }, { name: '学习', color: 1 }
    ];
    for (const c of cats) {
      const cat = { id: uid(), ...c };
      b.categories.push(cat); created.categories.push(cat);
    }
  }
  await saveDB(db);
  return created;
}

// 存储层故障时的统一提示：明确区分「数据库不可用」与「服务端 bug」，
// 避免 500 一律笼统报「服务器繁忙」导致无从排查（Render 免费库 30 天到期停用是常见诱因）。
const STORAGE_ERR_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo|terminating connection|Connection terminated|database .* does not exist|password authentication failed|relation .* does not exist|the database system is starting up|too many clients/i;
function storageErrMsg(e) {
  const m = (e && e.message) || '';
  return STORAGE_ERR_RE.test(m)
    ? '云端数据库当前不可用，暂时无法登录或同步数据'
    : '服务器繁忙，请稍后重试';
}
function storageErrPayload(e) {
  const m = (e && e.message) || '';
  const down = STORAGE_ERR_RE.test(m);
  return { error: storageErrMsg(e), code: down ? 'DB_DOWN' : 'SERVER_ERR', detail: m.slice(0, 200) };
}

// ---------- 认证路由 ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !/^\d{6,20}$/.test(String(phone))) return res.status(400).json({ error: '请输入有效的手机号' });
    if (!password || String(password).length < 4) return res.status(400).json({ error: '密码至少 4 位' });
    const result = await withLock(async () => {
      const db = await loadDB();
      if (db.users[phone]) return { conflict: true };
      const { salt, hash } = hashPassword(password);
      const id = uid();
      db.users[phone] = { id, phone: String(phone), salt, passwordHash: hash };
      userBucket(db, id); // 初始化空桶
      await saveDB(db);
      return { token: signToken(id, String(phone)), user: { id, phone: String(phone) } };
    });
    if (result && result.conflict) return res.status(409).json({ error: '该手机号已注册，请直接登录' });
    res.json(result);
  } catch (e) {
    console.error('[register] error:', e.message);
    res.status(500).json(storageErrPayload(e));
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const db = await loadDB();
    const u = db.users[phone];
    if (!u) return res.status(404).json({ error: '账号不存在，将自动创建', code: 'NO_ACCOUNT' });
    if (!verifyPassword(String(password || ''), u.salt, u.passwordHash)) {
      return res.status(401).json({ error: '密码错误', code: 'WRONG_PWD' });
    }
    const token = signToken(u.id, String(phone));
    res.json({ token, user: { id: u.id, phone: String(phone) } });
  } catch (e) {
    console.error('[login] error:', e.message);
    res.status(500).json(storageErrPayload(e));
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.uid, phone: req.phone } });
});

// ---------- 个人信息（昵称 / 头像）绑定到账号，云端持久化 ----------
function userById(db, id) {
  for (const phone in db.users) {
    if (db.users[phone] && db.users[phone].id === id) return db.users[phone];
  }
  return null;
}
app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const db = await loadDB();
    const u = userById(db, req.uid);
    if (!u) return res.status(404).json({ error: '账号不存在' });
    res.json({ nickname: u.nickname || '', avatar: u.avatar || '' });
  } catch (e) {
    console.error('[profile:get] error:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});
app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { nickname, avatar } = req.body || {};
    const result = await withLock(async () => {
      const db = await loadDB();
      const u = userById(db, req.uid);
      if (!u) return { notfound: true };
      if (typeof nickname === 'string') u.nickname = nickname.trim().slice(0, 20);
      if (typeof avatar === 'string') u.avatar = avatar.slice(0, 8);
      await saveDB(db);
      return { ok: true, nickname: u.nickname, avatar: u.avatar };
    });
    if (result.notfound) return res.status(404).json({ error: '账号不存在' });
    res.json(result);
  } catch (e) {
    console.error('[profile:put] error:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 健康检查（公开，必须放在通用 /api/:store 之前）----------
app.get('/api/health', async (req, res) => {
  let storage = 'file';
  let dbOk = true;
  let dbError = null;
  if (tcbColl) storage = 'cloudbase';
  else if (USE_PG) {
    storage = 'postgres';
    try { await pgRun((p) => p.query('SELECT 1')); }
    catch (e) { dbOk = false; dbError = (e.message || '').slice(0, 140); }
  }
  res.json({ ok: true, storage, dbOk, dbError, buildVersion: BUILD_VERSION });
});

// ---------- 种子 ----------
app.post('/api/seed-defaults', authMiddleware, async (req, res) => {
  const db = await loadDB();
  const created = await seedDefaults(db, req.uid);
  res.json({ ok: true, created });
});

// ---------- 导出 / 导入（必须放在 /api/:store 通配路由之前）----------
app.get('/api/export', authMiddleware, async (req, res) => {
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  res.json({ version: 1, exportedAt: new Date().toISOString(), data: b });
});
app.post('/api/import', authMiddleware, async (req, res) => {
  const incoming = req.body && req.body.data;
  if (!incoming) return res.status(400).json({ error: '缺少 data' });
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  for (const s of STORE_WHITELIST) {
    if (Array.isArray(incoming[s])) b[s] = incoming[s].map(it => ({ ...it, userId: req.uid }));
  }
  if (incoming.meta && typeof incoming.meta === 'object') b.meta = incoming.meta;
  await saveDB(db);
  res.json({ ok: true });
});

// ---------- 通用 CRUD ----------
app.get('/api/:store', authMiddleware, async (req, res) => {
  const { store } = req.params;
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  if (store === 'meta') {
    if (req.query.key) return res.json(b.meta[req.query.key] ?? null);
    return res.json(b.meta);
  }
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  let items = b[store];
  if (req.query.index && req.query.value !== undefined) {
    const idx = req.query.index;
    const val = req.query.value;
    items = items.filter(it => it[idx] === val || (Array.isArray(it[idx]) && it[idx].includes(val)));
  }
  // 性能优化：列表接口剥离交易照片(base64 大字段)，仅保留 hasPhoto 标志；照片按需经 /api/:store/:id 单条拉取
  if (store === 'transactions') {
    items = items.map(t => {
      if (t && t.photo) {
        const { photo, ...rest } = t;
        return { ...rest, hasPhoto: true };
      }
      return t;
    });
  }
  res.json(items);
});

app.get('/api/:store/:id', authMiddleware, async (req, res) => {
  const { store, id } = req.params;
  if (store === 'meta') return res.json(null);
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  const item = b[store].find(it => it.id === id);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});

app.post('/api/:store', authMiddleware, async (req, res) => {
  const { store } = req.params;
  if (store === 'meta') {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: '缺少 key' });
    const db = await loadDB();
    const b = userBucket(db, req.uid);
    b.meta[key] = value;
    await saveDB(db);
    return res.json({ ok: true });
  }
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  const item = { ...req.body, id: req.body.id || uid(), userId: req.uid };
  if (!item.createdAt) item.createdAt = new Date().toISOString();
  b[store].push(item);
  await saveDB(db);
  res.json(item);
});

app.put('/api/:store/:id', authMiddleware, async (req, res) => {
  const { store, id } = req.params;
  if (store === 'meta') return res.status(400).json({ error: 'meta 不支持该操作' });
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  const idx = b[store].findIndex(it => it.id === id);
  if (idx < 0) {
    // 不存在则按给定 id 创建（前端新建账目/习惯/笔记均走 PUT，等价于 upsert）
    const item = { ...req.body, id, userId: req.uid };
    if (!item.createdAt) item.createdAt = new Date().toISOString();
    b[store].push(item);
    await saveDB(db);
    return res.json(item);
  }
  b[store][idx] = { ...b[store][idx], ...req.body, id, userId: req.uid };
  await saveDB(db);
  res.json(b[store][idx]);
});

app.delete('/api/:store/:id', authMiddleware, async (req, res) => {
  const { store, id } = req.params;
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = await loadDB();
  const b = userBucket(db, req.uid);
  const before = b[store].length;
  b[store] = b[store].filter(it => it.id !== id);
  await saveDB(db);
  res.json({ ok: true, deleted: before - b[store].length });
});

// ---------- PWA：manifest / service worker / 图标 ----------
const MANIFEST = {
  name: '我的生活台',
  short_name: '生活台',
  description: '记账 · 打卡 · 笔记',
  start_url: '/',
  display: 'standalone',
  background_color: '#f0f2f5',
  theme_color: '#00b894',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
};
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(MANIFEST);
});
app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="#00b894"/><text x="96" y="132" font-size="104" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">台</text></svg>');
});
const SW_JS = `
const CACHE = 'life-tai-v1';
const ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api')) return;
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
      if (resp && resp.status === 200) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match('/')))
  );
});
`;
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(SW_JS);
});

// ---------- 前端静态托管（同源部署）----------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- 启动 ----------
async function initStore() {
  if (!USE_PG) {
    console.log('[workbench] 使用本地 JSON 文件存储:', DATA_FILE);
    return;
  }
  await pgRun((p) => p.query(
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)"
  ));
  // 可选：通过环境变量 SEED_PHONE / SEED_PASSWORD 在数据库为空时预建账号
  const db = await loadDB();
  if (Object.keys(db.users || {}).length === 0 && process.env.SEED_PHONE && process.env.SEED_PASSWORD) {
    const { salt, hash } = hashPassword(process.env.SEED_PASSWORD);
    const id = uid();
    db.users[process.env.SEED_PHONE] = { id, phone: String(process.env.SEED_PHONE), salt, passwordHash: hash };
    userBucket(db, id);
    await saveDB(db);
    console.log('[workbench] 已预建账号:', process.env.SEED_PHONE);
  }
  console.log('[workbench] 使用 PostgreSQL 持久化存储');
}

initStore()
  .catch((e) => console.error('[workbench] 存储初始化失败:', e.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`[workbench] server listening on http://localhost:${PORT}`);
    });
  });
