# 个人工作台 — 云端后端

手机号 + 密码登录、多设备同步的云端后端。前端（单文件 HTML）由本服务同源托管。

## 本地运行
```bash
npm install
PORT=3001 node server.js
# 打开 http://localhost:3001
```

## 部署到 Render（免费）
1. 把本目录推送到你的 GitHub 仓库。
2. 在 Render 新建 **Blueprint**，连接该仓库，使用根目录的 `render.yaml`。
3. 在 Render 后台为该服务**挂载一个 Disk**（挂载路径 `/data`，名称任意），
   这样 `DATA_FILE=/data/db.json` 才会持久保存，重启不丢数据。
4. 部署完成后打开网址，手机号 + 密码**注册**一个账号即可使用。

> 数据按 userId 隔离；默认 `SECRET` 会在 Render 上自动生成，token 随之失效重登即可。

## 环境变量
- `PORT`：监听端口（Render 自动注入）
- `SECRET`：token 签名密钥（Render 自动生成，本地可留空）
- `DATA_FILE`：数据库文件路径，默认 `./data/db.json`，挂载盘时设为 `/data/db.json`

## 接口
- `POST /api/auth/register` / `POST /api/auth/login` — 注册 / 登录
- `GET  /api/export` / `POST /api/import` — 导出 / 导入（整体覆盖）
- 通用 CRUD：`GET/POST/PUT/DELETE /api/:store`（store ∈ ledgers, transactions, habits, checkins, categories, notes, settlements）
- `GET  /api/health` — 健康检查
