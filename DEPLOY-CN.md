# 生活台 — 国内部署 & 安全处理手册

> 生成时间：2026-09-09　｜　目标：让手机在国内网络随时能打开，且账号数据不再依赖境外节点。

---

## 一、为什么必须迁移（已实测的诊断结论）

现象：手机 / 国内网络经常打不开 `https://workbench-server-bpps.onrender.com`。

实测（2026-09-09，用三家国内公共 DNS 分别解析）：

| DNS | 解析结果 |
|---|---|
| 阿里 223.5.5.5 | ✅ 正常 |
| 腾讯 DNSPod 119.29.29.29 | ✅ 正常 |
| 114.114.114.114 | ✅ 正常 |

三家都能正常解析，但最终 CNAME 到：

```
workbench-server-bpps.onrender.com
  → gcp-us-west1-1.origin.onrender.com
    → *.cdn.cloudflare.net  →  IP 216.24.57.x（Cloudflare）
```

**结论：不是 DNS 污染，是"国内 ⇄ 境外 Cloudflare 节点"这条链路被间歇性干扰。**

→ 所以「改 DNS」这条路无效，之前给过你的这个建议作废；要彻底解决只能把服务搬到国内节点。

---

## 二、方案：腾讯云 CloudBase 云托管

选它的原因（你没有备案域名，这是硬约束）：

- 平台提供默认公网域名，**国内可直连、免备案**
- Node 容器直接跑现在的 Express，**业务代码零改造**
- 数据存 CloudBase 云数据库，**跨重启不丢**

存储结构设计（规避限制）：

```
accounts  →  __users__        （账号表，1 个文档）
用户数据  →  <userId>         （每个用户 1 个文档）
```

> 之所以不把整个库存成 1 个大文档：CloudBase 单文档上限 **16MB**。
> 你的记账有「拍照留存」，照片是 base64 存在数据里的，整库一个文档迟早会超限。

---

## 三、我这边已经做完的技术改造

| 项目 | 状态 |
|---|---|
| `server.js` 新增第三种存储后端 | ✅ 优先级：CloudBase > PostgreSQL > 本地文件 |
| 向后兼容回归验证 | ✅ 不设 `TCB_ENV_ID` 时行为完全不变（health 返回 `storage:"file"`，首页 200） |
| `Dockerfile` / `.dockerignore` / `cloudbaserc.json` | ✅ 已生成 |
| 上述部署文件不推 GitHub | ✅ 已加进 `.gitignore`（防止 Render 误判为 Docker 运行时） |
| `/api/health` 返回存储类型 | ✅ 部署后一查就知道有没有真连上云数据库 |

---

## 四、你要做的事（3 步）

### 第 1 步：开通 CloudBase 环境（约 10 分钟）

1. 注册 / 登录腾讯云 <https://cloud.tencent.com>（需实名认证）
2. 打开「云开发 CloudBase」控制台 <https://tcb.cloud.tencent.com/>
3. **新建环境**：地域选「上海」或「广州」，套餐先选「按量计费」
4. 建好后复制 **环境 ID**（形如 `workbench-1x2y3z`）

### 第 2 步：打包并部署（约 10 分钟）

1. 把 `F:\小Q的工作台\server` 目录打成 zip（**排除** `node_modules` / `data` / `.git`）
2. CloudBase 控制台 → 该环境 → **云托管** → **新建服务**
3. 部署方式：本地上传代码包；构建方式：**Dockerfile**
4. 环境变量（这一步最关键）：

   | 变量名 | 值 |
   |---|---|
   | `TCB_ENV_ID` | 你在第 1 步复制的环境 ID |
   | `SECRET` | 任意一长串随机字符（登录 token 签名用，自己定） |
   | `PORT` | `80` |

5. 容器规格选最小即可；**最小实例数设 0 最省钱**（首次访问有几秒冷启动），设 1 则秒开但贵。

### 第 3 步：验证 + 手机启用（约 5 分钟）

1. 浏览器打开：`https://你的服务域名/api/health`

   - ✅ 正确：`{"ok":true,"storage":"cloudbase",...}`
   - ⚠️ 若显示 `"storage":"file"`，说明 `TCB_ENV_ID` 没生效或 SDK 没装上 —— **此时数据无法持久保存，请先别用**

2. 打开首页 → 注册 / 登录你的账号
3. 把 Render 上的历史数据搬过来：在 Render 版用「导出」拿到 JSON，再到新地址用「导入」
4. 手机浏览器打开新域名 → 加到桌面，即可像 App 一样用

### 费用参考

最小规格 + 实例数 0 的个人低频使用，一般**每月几十元以内**（具体以控制台实时显示为准）。Render 那套建议先留着做过渡备份。

---

## 五、GitHub PAT（令牌）安全处理

### 我这边已完成

- 全盘扫描本机，历史日志中共 **86 处明文 PAT** 已全部替换为占位符（二进制安全处理，日志内容未损坏）
- 严格复核通过：**不存在** `ghp_` + 20 位以上真实 token 的残留
- 顺带确认：git 认证本身是安全的 —— remote URL 不含 PAT，凭证存在 **Windows 凭据管理器**里，没有明文文件

### 你必须做的（我无权登录你的 GitHub 网页）

> ⚠️ **顺序很重要：先换新，再删旧**，否则中间会推不了代码。

1. 打开 <https://github.com/settings/tokens/new> 生成**新**令牌
   - 建议选 **Fine-grained personal access token**（比 classic 安全）
   - Repository access：`Only select repositories` → 选 `life`
   - Permissions：Repository permissions → **Contents: Read and write**
   - 生成后立刻复制（只显示这一次）
2. **先把新令牌存进本机**（在你自己的终端执行，令牌不需要给我）：

   ```bash
   printf "protocol=https\nhost=github.com\nusername=liqiuyan02-dotcom\npassword=这里换成新令牌\n" | git credential approve
   ```

3. 验证生效：

   ```bash
   git ls-remote origin main
   ```

   能返回一串 commit 号就说明成功了。
4. **确认能用之后**，再打开 <https://github.com/settings/tokens> 删除旧令牌。

---

## 六、后续可选优化

- **照片搬去对象存储**：现在记账照片是 base64 塞在数据里，会让单用户数据快速膨胀。必要时可改成上传到 COS / CloudBase 云存储，数据里只存 URL。
- **多实例并发写**：目前「读-改-写」由单进程内存锁串行化，个人使用没问题；若以后多实例扩容器，需要换成数据库事务锁。
