# qota — OTA Version Manager on Cloudflare

OTA 升级包多租户版本管理平台,部署到 Cloudflare Workers + Pages,文件存 R2(走 S3
兼容端点直传 / 短期 presigned 下载),元数据存 D1。完整审计日志。

> **自托管 / 本地无需对象存储**:同一套代码也能跑在 Node 运行时(`npm run dev`、
> Docker),默认把文件存到**本地文件夹**,不需要 MinIO/S3——见 [DEPLOY.md](DEPLOY.md)。
> 配了 S3/R2 就自动切换为对象桶;Cloudflare 部署始终用 R2 桶。

## 角色 & 权限模型

**全局角色**
- `super_admin` — 隐式拥有所有客户/项目的全部权限
- `admin` — 全局管理,但不能管理超级管理员或同级管理员
- `developer` — 没有全局权限,所有访问通过 memberships 授权
- `observer` — 全局只读 + 下载

**租户内角色**(memberships.role / project_memberships.role)
- `customer_admin` — 该客户/项目的全部权限,可发放/吊销成员、API token、版本
- `developer` — 上传、下载、查看、删除版本;发 API token;不能管成员
- `viewer` — 只读 + 下载

**非用户主体**(api_tokens.kind)
- `device` — 终端设备拉 OTA,scope 必须是 download
- `ci` — CI 上传 OTA,scope 可为 upload / download / full

任何列表接口在 SQL 层就 JOIN 权限表过滤,无权限的客户/项目根本不会出现在响应里。
每一次状态变更/上传/下载都写 `audit_logs`,带 IP / UA / actor。

### 多层客户与项目成员

客户支持“客户 → 子客户 → 下级客户”的多层结构。管理员可以在客户列表中
新增子客户，也可以编辑已有客户的上级；既有客户升级后保持顶层。
客户代号仍全局唯一，调整层级不会更改项目、固件路径或成员授权。
系统拒绝把客户移到自己或自己的子孙之下；有子客户的客户不能直接删除，
需先移走或处理子客户。

父子客户**独立授权，不自动继承**。成员授权可先选用户、客户，再选择：

- **选择项目**：勾选一个或多个直属项目，只授权所选项目，不包含未来新增项目。
- **客户全部项目**：覆盖该客户当前及未来的直属项目，不包含子客户的项目。

项目成员角色优先于该客户的成员角色；新增项目授权不会撤销已有客户授权，
撤销项目授权后仍可能回到已有的客户权限。全局管理员、超级管理员和观察者
保留原有的全局权限。用户列表提供“成员授权”入口，可以直接查看和管理该用户的授权。

`POST /api/customers` 和 `PATCH /api/customers/:id` 支持 `parentId`，`null` 表示顶层。
`POST /api/memberships/batch` 接收 `{ userId, projectIds, role }`，一次最多新增
200 个项目授权；项目无权限、不存在或已有重复授权时整批失败，不会部分保存。

## 公告与邮件通知

登录首页是公告栏。公告按项目权限显示；单独发布时可关联该项目已有版本，
也可选择不关联版本。上传固件时可以同时发布公告，同一批文件只发布一次。

管理员在侧栏「邮箱配置」中保存 SMTP 服务器、端口、加密方式、发件人、
登录账号和密码/授权码。支持 SSL/TLS（通常 465）和 STARTTLS（通常 587），
始终校验证书并在加密连接中登录。配置下方的「邮箱测试」可填写测试收件地址，
使用已保存配置发送测试邮件；无需先开启公告通知。
Cloudflare 默认不允许 SMTP 25 端口，详情见
[Cloudflare TCP sockets 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。

启用邮箱后，发布公告可以勾选「邮件通知」，从有权查看该项目的活跃用户中
选择收件人，支持全选和取消全选（每次最多 200 人）。通知逐人发送，互不暴露
收件地址。发送前再次检查权限；关闭账号或撤销权限的收件人会跳过。
邮件失败不影响公告和固件保存，公告会显示发送进度及继续发送/重试入口。
页面在打开期间自动分批续发待发送邮件；离开页面导致中断时，可重新进入公告栏继续。
已成功发送的记录不再发送，编辑公告正文不会重新发送已发送的邮件。

邮件密码以 AES-GCM 加密存储，接口不回传密码。保存时省略 `password` 保留原值；
更换 `JWT_SECRET` 后需要重新保存邮箱密码。

相关接口（使用浏览器用户 Bearer token）：

| 接口 | 用途 |
| --- | --- |
| `GET/PUT /api/mail/settings` | 管理员读取/保存邮箱配置 |
| `GET /api/mail/status` | 查询邮箱是否已配置、是否已启用 |
| `POST /api/mail/test` | 管理员测试，正文 `{ "to": "test@example.com" }` |
| `GET /api/announcements/recipients?projectId=1` | 发布者查询项目可选收件人 |
| `POST /api/announcements` | `projectId`、`content`、可选 `version`、可选 `recipientIds` |
| `POST /api/announcements/:id/mail/retry` | 公告管理者继续/重试；`retryFailed: false` 只处理待发送项 |

上传接口中的 `announcement` 同样支持 `recipientIds`。未提供或空数组均不发邮件。
通知接口每次最多处理 3 封，调用方可根据公告的 `mail.pending` 分批继续；失败项
需主动重试。发送后进程突然中断可能无法确认服务器是否已接收，5 分钟后手动
恢复此类记录可能重复发送，请先核对收件箱。

## 目录

```
qota/
├── apps/
│   ├── worker/                    # Cloudflare Worker API
│   │   ├── src/
│   │   │   ├── index.ts           # Hono app + CORS + error handler
│   │   │   ├── env.ts
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts         # login / me / change-password
│   │   │   │   ├── users.ts        # super_admin/admin user CRUD
│   │   │   │   ├── customers.ts    # tenant CRUD
│   │   │   │   ├── projects.ts     # project CRUD (per customer)
│   │   │   │   ├── memberships.ts  # role grants (customer + project)
│   │   │   │   ├── api-tokens.ts   # device / CI tokens
│   │   │   │   ├── versions.ts     # version metadata (list/get/patch/delete)
│   │   │   │   ├── upload.ts       # multipart init/sign-part/complete/abort/sessions
│   │   │   │   ├── download.ts     # user grant + device 302 → R2 presigned
│   │   │   │   └── audit.ts        # log reader (scope-filtered)
│   │   │   ├── middleware/auth.ts  # requireUser / requireAdmin
│   │   │   ├── lib/
│   │   │   │   ├── memberships.ts  # permission resolver
│   │   │   │   ├── s3.ts           # R2 S3 client (aws4fetch): multipart + presign
│   │   │   │   └── audit.ts        # append-only logger
│   │   │   └── utils/              # PBKDF2, JWT, SHA, encoding, errors
│   │   ├── migrations/0001_init.sql
│   │   ├── scripts/seed.mjs        # bootstrap first super_admin
│   │   └── wrangler.toml
│   └── web/                       # React + Vite + Tailwind + TanStack Query
│       └── src/
│           ├── lib/
│           │   ├── api.ts          # typed REST client
│           │   ├── auth.tsx
│           │   ├── upload.ts       # browser multipart uploader (PUT direct to R2)
│           │   └── utils.ts        # cn(), formatBytes
│           ├── pages/              # Login, Customers, Projects, ProjectDetail (versions+tokens), Users, Permissions(=Memberships)
│           └── components/Layout.tsx
├── packages/shared/                # TS DTOs reused by worker + web + cli
├── scripts/upload.mjs              # Node CLI multipart uploader for CI
├── README.md
└── package.json                    # npm workspaces root
```

## Prereqs

- Node.js ≥ 18.18
- npm ≥ 9
- Cloudflare account with R2 enabled (free tier ok)
- (deploy) `wrangler login`

## 本地开发

```bash
cd ~/workspace/qota
npm install
npm run dev
```

`npm run dev` 使用 Node 运行时:API 在 http://127.0.0.1:8080,Vite 在
http://localhost:5173,文件默认存到 `apps/worker/data/blobs`,不需要 R2/MinIO。
支持内置 SQLite 的 Node 版本会自动使用 `node:sqlite`;较旧的 Node 版本使用
可选的 `better-sqlite3` 依赖,避免新版 Node 因原生模块版本不匹配而无法启动。
第一次启动如果数据库为空,会自动创建 `ADMIN_EMAIL` / `ADMIN_PASSWORD`
(默认 `admin@example.com` / `admin12345`)。

### 其他启动方式

```bash
npm run docker      # Docker Compose,访问 http://localhost:8080
npm run cloudflare  # Wrangler Pages 本地模拟,访问 wrangler 输出的本地地址
```

`npm run docker` 需要根目录 `.env` 中设置 `JWT_SECRET`。可以从模板开始:

```bash
cp .env.example .env
# 编辑 JWT_SECRET,例如: openssl rand -hex 32
```

`npm run cloudflare` 使用 Cloudflare Pages/Workers 模拟环境,适合检查 D1/R2
部署行为。它需要 Cloudflare 绑定和 R2/D1 配置;普通本地开发优先用
`npm run dev`。

### Cloudflare 本地凭据

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# 编辑 .dev.vars,填入 JWT_SECRET (openssl rand -hex 32) 和你的 R2 S3 keys。

npx wrangler r2 bucket create qota-ota

# 创建 R2 S3 API token:Cloudflare dashboard → R2 → Manage API tokens
#   → Create API token → 权限 Object Read & Write,Bucket scope 选 qota-ota。
# 拿到 Access Key ID + Secret Access Key,写入 .dev.vars。

# R2 CORS — 浏览器要直接 PUT 到 R2,必须把 Pages/Vite origin 加入 allowed 列表,
# 并且 ExposeHeaders 必须包含 ETag (否则 multipart complete 拿不到 ETag)
cat > /tmp/qota-cors.json <<'EOF'
[
  {
    "AllowedOrigins": ["http://localhost:5173", "https://qota.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
EOF
npx wrangler r2 bucket cors put qota-ota --rules /tmp/qota-cors.json
```

### Cloudflare D1 迁移 + 种入第一个 super_admin

```bash
npm run db:migrate:local

ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='change-me-now' ADMIN_NAME='Root' \
  npm run -w apps/worker seed -- --local
```

访问 http://localhost:5173,用刚才的邮箱登录。

最小链路自检:
1. **Customers** 页面 → New customer (`acme`)
2. **Projects** 页面 → New project (`firmware-a`)
3. **(Project detail)** → Upload new version → 选个文件,version 填 `1.0.0`
   - 浏览器会先 sha256 → init session → 并发 PUT 分片直传 R2 → complete
4. **(Project detail)** → API tokens → Issue token (device) → 复制 `qd_xxx...`
5. 设备端:
   ```bash
   curl -L --output ota.bin -H "Authorization: Bearer qd_xxx..." \
     http://127.0.0.1:8787/api/download/device/latest
   ```
6. **Audit log** 在 `/api/audit` 端点可查;UI 暂未实现专用页面(follow-up)。

### 5. Typecheck

```bash
npm run typecheck
```

## 部署到 Cloudflare

> **推荐:Cloudflare Pages + 连 Git 自动部署(空构建命令,和 remote-file 一样)。**
> 构建产物(`apps/web/dist`:静态前端 + 把整个 Hono API 打包成的 `_worker.js`)**直接提交进仓库**,
> Cloudflare 用**空构建命令**直接服务,无需在云端 `npm install`/构建。前端与 API **同域**,首次访问自动建管理员。
> 代价:改动代码后 push 前要先跑 `npm run pages:build` 重新生成并提交产物。完整步骤见 [DEPLOY.md](DEPLOY.md) 的 *Option B*;
> 「独立 Worker + Pages」手动方式见 *Option C*。

### 1. 远端 R2 桶(若还没)

```bash
npx wrangler r2 bucket create qota-ota
# 同上配 CORS,加入你的 Pages 域名到 AllowedOrigins
```

### 2. 远端 D1

```bash
npx wrangler d1 create qota-db
# 把 database_id 写到 apps/worker/wrangler.toml
npm run db:migrate:remote
```

### 3. Worker secrets

```bash
cd apps/worker
npx wrangler secret put JWT_SECRET                  # openssl rand -hex 32
npx wrangler secret put R2_ACCESS_KEY_ID            # 从 R2 API token
npx wrangler secret put R2_SECRET_ACCESS_KEY
# wrangler.toml 里的 R2_ACCOUNT_ID 和 R2_BUCKET_NAME 改成真实值
cd ../..
```

### 4. 部署 Worker

```bash
npm run deploy:worker
# → https://qota-api.<acct>.workers.dev  或绑定 Custom Domain (api.qota.example.com)
```

### 5. 远端种入 super_admin

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='strong-pw' \
  npm run -w apps/worker seed -- --remote
```

### 6. 前端 Pages

```bash
npm run build
npm run deploy:web
```

把 Pages 域名加到 worker `wrangler.toml` 的 `ALLOWED_ORIGINS`,也加到 R2 CORS。

把 `/api/*` 指到 Worker(任一方式):
- **同域**:Cloudflare Workers Routes 把 `qota.example.com/api/*` → `qota-api` worker
- **独立子域**:Worker 绑 `api.qota.example.com`,build 时设
  `VITE_API_BASE=https://api.qota.example.com`(目前 api.ts 用相对 `/api/...`,
  如需绝对地址自行加 `import.meta.env.VITE_API_BASE` 前缀)

## API 速查

### 用户登录(浏览器/CLI/CI)

```bash
TOKEN=$(curl -sS -X POST https://api.qota.example.com/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ci@example.com","password":"..."}' | jq -r .token)
```

### 上传 OTA(CI / 浏览器都走同一套 multipart 协议)

最简单用 CLI:

```bash
QOTA_API=https://api.qota.example.com QOTA_TOKEN=$TOKEN \
  node scripts/upload.mjs \
    --project-id 3 \
    --version 1.2.3 \
    --channel stable \
    --notes 'CI build #4571' \
    --file ./build/firmware-1.2.3.bin
```

中断后可恢复:`--resume <sessionId>`(失败时会打印 sessionId)。

### 设备下载

```bash
# 拿最新 stable,302 跳到 R2 短链(5min TTL)
curl -L --output ota.bin \
  -H "Authorization: Bearer qd_XXXXXXXXXXXX..." \
  https://api.qota.example.com/api/download/device/latest

# 拿元数据 JSON(不下载文件)
curl -H "Authorization: Bearer qd_..." \
  'https://api.qota.example.com/api/download/device/latest?format=json'

# 指定版本(token 不能跨 project)
curl -L --output ota.bin -H "Authorization: Bearer qd_..." \
  https://api.qota.example.com/api/download/device/version/42
```

每个响应都带:`x-ota-sha256` / `x-ota-version` / `x-ota-channel`(也可走 JSON 拿到)。

### Web 用户下载

后台 *Download* 按钮调 `POST /api/download/grant`,得到 5min presigned URL,然后浏览
器直拉 R2(不经 Worker 流量)。

### 当前使用、归档与备注

同一项目可以同时标记多个版本号为“当前使用”,也可以单独取消。标记覆盖该版本号下
所有就绪通道;设备 `/device/latest` 优先选择所请求通道中最新上传的当前版本,
没有匹配的当前版本时选择该通道最新的就绪版本。

项目页固定按“版本 → 项目公告 → 归档 → API 令牌”显示。
版本列表支持归档单个版本或单个文件,归档后显示在项目公告下方的
“归档”区域,并可恢复。归档整个版本会取消它的当前使用标记;恢复不会自动重新标记。

版本汇总行显示独立的“版本备注”,展开后的每个文件显示自己的“文件备注”,两者分别保存,
互不覆盖。单文件版本也有这两层备注。备注列最多显示两行,点击可查看全文或编辑。
版本备注仅允许版本创建者（最早文件的上传者）或有权限的管理员修改;文件备注仅允许该文件
原上传者或有权限的管理员修改。当前使用中的版本必须先单独取消当前使用,才能修改任一层备注。

升级时原有文件备注保持不变。若一个版本的所有文件备注完全一致,会用它初始化版本备注;
若文件备注不同,版本备注初始为空,可单独填写。

### 批量上传

上传窗口支持一次选择多个文件,共用版本号。窗口下方的备注固定为“版本备注”,
每个文件还可以在对应文件行单独选择或新建通道、填写“文件备注”,两者分别保存。
通道默认使用项目的默认通道。选择已有版本会预填其版本备注;上传后也可在版本汇总行编辑。
同一版本、同一通道可以保留多个不同名称的文件,
同名文件也可以分配到不同通道;只有版本号、通道和文件名都相同时才需要确认覆盖。
文件依次上传并分别显示进度和结果。部分文件失败不会中断其他文件,重试只处理未成功的文件。
取消会停止当前上传和后续队列,已经成功上传的文件会保留。

设备可通过 `/device/list` 获取各文件 ID 后分别下载,也可在 `/device/latest` 添加
`filename` 参数筛选指定文件名。不指定文件名时保持原有的最新文件选择规则。

### API 令牌的授权范围

签发令牌时可以分别限制通道、特殊版本、版本号和具体固件文件。留空的条件
表示不限制，填写多个条件时必须**同时满足**，例如“版本 `V2.0.0` + 通道 `ota`”。
具体固件对应版本展开后的一条文件记录；版本号则包含该版本下符合其它条件的文件。
特殊版本按版本当前的特殊版本字段匹配，后续修改该字段会影响授权集合。

`POST /api/api-tokens` 在现有字段之外支持 `specialVersion`、`version`、`versionId`；
三项可省略或传 `null`，其中 `versionId` 是具体文件的数字 ID。
版本类组合必须匹配本项目已有的就绪或归档文件。单独限制通道仍支持为未来通道签发。
旧令牌不增加限制，保留原有授权。

列表、最新版本和指定文件三个设备下载接口都执行相同授权过滤。查询参数只能
缩小范围；文件归档后不能下载，恢复就绪后才可继续。指定文件被删除后，令牌
保留原文件 ID，不会变成全项目授权，也不会自动授权同名的新文件。

`/device/latest` 对旧令牌保留默认 `stable` 通道；设置了版本类限制的新令牌，
在未指定通道时从授权集合中选择最新文件，优先当前使用的版本。
该设置控制令牌下载范围，不更改登录用户权限、公开下载链接或已签发链接的有效期。

## 上传协议(参考)

上传接口使用登录用户的 `Authorization: Bearer <jwt>`，并检查项目上传权限:

| Step | Request | Notes |
| --- | --- | --- |
| `POST /api/upload/init` | `{ projectId, filename, totalSize, version, releaseChannel?, expectedSha256?, partSizeHint?, notes?, versionNotes?, isMandatory?, minVersion?, maxVersion?, rolloutPercentage?, overwriteExisting? }` | Worker 用 R2 S3 endpoint 调 CreateMultipartUpload,返回 `sessionId/uploadId/key/partSize/partCount/uploadedParts`。`notes` 仅用于文件备注,`versionNotes` 仅用于版本备注（省略不修改,`null` 清空）。同版本、同通道、同文件名返回 409,设置 `overwriteExisting: true` 可明确覆盖该文件。 |
| `POST /api/upload/sign-part` | `{ sessionId, partNumber }` | 返回 10min 短期 presigned PUT URL。 |
| `PUT <presigned url>` | 二进制分片 | 客户端直传 R2。响应 header `ETag` 必须能读到 → 检查 CORS。 |
| `POST /api/upload/complete` | `{ sessionId, parts:[{partNumber, etag, size}], sha256 }` | Worker CompleteMultipartUpload + HEAD 校验 + 写 `versions(status=ready)`。 |
| `POST /api/upload/abort` | `{ sessionId }` | AbortMultipartUpload + 标记 session aborted。 |
| `GET  /api/upload/sessions?projectId=N` | — | 列出本项目的 session,可用 `?status=in_progress` 过滤。 |
| `GET  /api/upload/sessions/:id` | — | 详情 + 已上传分片列表,前端可基于此恢复。 |

## 数据布局

新上传的 R2 key:`<customer_code>/<project_code>/<channel>/<version>/<upload_uuid>/<safe_filename>`。
每次上传使用独立路径,不同文件名和并发上传不会相互覆盖;已有文件路径保持不变。
可在 Cloudflare dashboard / `wrangler r2 object list qota-ota` 直接浏览。

## 设计取舍 & TODO

**已做**
- 多租户角色 + 显式 SQL-层权限过滤
- R2 S3 multipart 直传(避开 Cloudflare 300MB 单请求上限)
- 5min 短期 presigned 下载,带审计
- 每动作 audit log
- 断点续传(session + uploaded_parts 都落 D1)
- CLI 多并发上传 + 重试 + 续传

**MVP 留作 schema 但不强制的字段** (rollout_percentage / device_group_id / min_version
/ max_version / is_mandatory):接口和 DB 已经写入这些字段,设备 `/device/latest`
端目前 **只** 选 "最新 status=ready 且 channel 匹配" 的一条,不做百分比/分组裁切。
要加灰度时改 `routes/download.ts:downloadRoutes.get('/device/latest')` 的 SQL 就行,
不需要 migrate。

**Follow-up(用户喊了再做)**
- TanStack Table 化版本/审计列表
- 完整 shadcn/ui 组件迁移(目前 Tailwind 已通,但旧组件还在用原 CSS)
- 专用 Audit 页面(后端 `/api/audit` 已经实现)
- Web 端断点续传 UI(库已支持,UI 没暴露 resume 入口)
- 强制最低版本 / 设备分组下发的 device 端逻辑
- R2 multipart 失败的后台清理 cron (可挂 wrangler scheduled trigger)
