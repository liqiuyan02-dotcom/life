// 临时脚本：用与 server.js 完全相同的算法为账号 15989106650 / 123456 预创建数据
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const phone = '15989106650';
const password = '123456';

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const db = {
  users: {
    [phone]: { id, phone, salt, passwordHash: hash }
  },
  data: {}
};

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
console.log('created account', phone, '->', DATA_FILE);
