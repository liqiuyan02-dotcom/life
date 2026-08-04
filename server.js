/**
 * 个人工作台 — 云端后端
 * 仅依赖 express。数据存 JSON 文件（server/data/db.json），按 userId 隔离。
 * 认证：手机号 + 密码（crypto.scrypt 哈希），token 用 HMAC-SHA256 签名。
 * 同源部署：后端同时用 express.static 托管 public/index.html，前端 fetch('/api/...') 同源。
 *
 * 启动： node server.js   （可选环境变量 PORT / SECRET / DATA_FILE）
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'workbench-dev-secret-change-me';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

const app = express();
app.use(express.json({ limit: '5mb' }));

// 允许跨域（前端与后端可能不同源，同源时此配置无害）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 数据层 ----------
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, data: {} };
  }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
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
const STORE_WHITELIST = ['ledgers', 'transactions', 'habits', 'checkins', 'categories', 'notes', 'settlements'];
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function seedDefaults(db, userUid) {
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
  saveDB(db);
  return created;
}

// ---------- 认证路由 ----------
app.post('/api/auth/register', (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !/^\d{6,20}$/.test(String(phone))) return res.status(400).json({ error: '请输入有效的手机号' });
  if (!password || String(password).length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const db = loadDB();
  if (db.users[phone]) return res.status(409).json({ error: '该手机号已注册，请直接登录' });
  const { salt, hash } = hashPassword(password);
  const id = uid();
  db.users[phone] = { id, phone: String(phone), salt, passwordHash: hash };
  userBucket(db, id); // 初始化空桶
  saveDB(db);
  const token = signToken(id, String(phone));
  res.json({ token, user: { id, phone: String(phone) } });
});

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body || {};
  const db = loadDB();
  const u = db.users[phone];
  if (!u || !verifyPassword(String(password || ''), u.salt, u.passwordHash)) {
    return res.status(401).json({ error: '手机号或密码错误' });
  }
  const token = signToken(u.id, String(phone));
  res.json({ token, user: { id: u.id, phone: String(phone) } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.uid, phone: req.phone } });
});

// ---------- 健康检查（公开，必须放在通用 /api/:store 之前）----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- 种子 ----------
app.post('/api/seed-defaults', authMiddleware, (req, res) => {
  const db = loadDB();
  const created = seedDefaults(db, req.uid);
  res.json({ ok: true, created });
});

// ---------- 导出 / 导入（必须放在 /api/:store 通配路由之前）----------
app.get('/api/export', authMiddleware, (req, res) => {
  const db = loadDB();
  const b = userBucket(db, req.uid);
  res.json({ version: 1, exportedAt: new Date().toISOString(), data: b });
});
app.post('/api/import', authMiddleware, (req, res) => {
  const incoming = req.body && req.body.data;
  if (!incoming) return res.status(400).json({ error: '缺少 data' });
  const db = loadDB();
  const b = userBucket(db, req.uid);
  for (const s of STORE_WHITELIST) {
    if (Array.isArray(incoming[s])) b[s] = incoming[s].map(it => ({ ...it, userId: req.uid }));
  }
  if (incoming.meta && typeof incoming.meta === 'object') b.meta = incoming.meta;
  saveDB(db);
  res.json({ ok: true });
});

// ---------- 通用 CRUD ----------
app.get('/api/:store', authMiddleware, (req, res) => {
  const { store } = req.params;
  if (store === 'meta') {
    const db = loadDB();
    const b = userBucket(db, req.uid);
    if (req.query.key) return res.json(b.meta[req.query.key] ?? null);
    return res.json(b.meta);
  }
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = loadDB();
  const b = userBucket(db, req.uid);
  let items = b[store];
  if (req.query.index && req.query.value !== undefined) {
    const idx = req.query.index;
    const val = req.query.value;
    items = items.filter(it => it[idx] === val || (Array.isArray(it[idx]) && it[idx].includes(val)));
  }
  res.json(items);
});

app.get('/api/:store/:id', authMiddleware, (req, res) => {
  const { store, id } = req.params;
  if (store === 'meta') return res.json(null);
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = loadDB();
  const b = userBucket(db, req.uid);
  const item = b[store].find(it => it.id === id);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});

app.post('/api/:store', authMiddleware, (req, res) => {
  const { store } = req.params;
  if (store === 'meta') {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: '缺少 key' });
    const db = loadDB();
    const b = userBucket(db, req.uid);
    b.meta[key] = value;
    saveDB(db);
    return res.json({ ok: true });
  }
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = loadDB();
  const b = userBucket(db, req.uid);
  const item = { ...req.body, id: req.body.id || uid(), userId: req.uid };
  if (!item.createdAt) item.createdAt = new Date().toISOString();
  b[store].push(item);
  saveDB(db);
  res.json(item);
});

app.put('/api/:store/:id', authMiddleware, (req, res) => {
  const { store, id } = req.params;
  if (store === 'meta') return res.status(400).json({ error: 'meta 不支持该操作' });
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = loadDB();
  const b = userBucket(db, req.uid);
  const idx = b[store].findIndex(it => it.id === id);
  if (idx < 0) {
    // 不存在则按给定 id 创建（前端新建账目/习惯/笔记均走 PUT，等价于 upsert）
    const item = { ...req.body, id, userId: req.uid };
    if (!item.createdAt) item.createdAt = new Date().toISOString();
    b[store].push(item);
    saveDB(db);
    return res.json(item);
  }
  b[store][idx] = { ...b[store][idx], ...req.body, id, userId: req.uid };
  saveDB(db);
  res.json(b[store][idx]);
});

app.delete('/api/:store/:id', authMiddleware, (req, res) => {
  const { store, id } = req.params;
  if (!STORE_WHITELIST.includes(store)) return res.status(400).json({ error: '无效的数据表' });
  const db = loadDB();
  const b = userBucket(db, req.uid);
  const before = b[store].length;
  b[store] = b[store].filter(it => it.id !== id);
  saveDB(db);
  res.json({ ok: true, deleted: before - b[store].length });
});

// ---------- 前端静态托管（同源部署）----------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[workbench] server listening on http://localhost:${PORT}`);
});
