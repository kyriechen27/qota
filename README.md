# qota — OTA Version Manager on Cloudflare

OTA 升级包多租户版本管理平台,部署到 Cloudflare Workers + Pages,文件存 R2(走 S3
兼容端点直传 / 短期 presigned 下载),元数据存 D1。完整审计日志。

> **自托管 / 本地无需对象存储**:同一套代码也能跑在 Node 运行时(`npm run dev:node`、
> Docker),默认把文件存到**本地文件夹**,不需要 MinIO/S3——见 [DEPLOY.md](DEPLOY.md)。
> 配了 S3/R2 就自动切换为对象桶;Cloudflare 部署始终用 R2 桶。

## 角色 & 权限模型

**全局角色**(users.role)
- `super_admin` — 隐式拥有所有客户/项目的全部权限
- `developer` — 没有全局权限,所有访问通过 memberships 授权

**租户内角色**(memberships.role / project_memberships.role)
- `customer_admin` — 该客户/项目的全部权限,可发放/吊销成员、API token、版本
- `developer` — 上传、下载、查看、删除版本;发 API token;不能管成员
- `viewer` — 只读 + 下载

**非用户主体**(api_tokens.kind)
- `device` — 终端设备拉 OTA,scope 必须是 download
- `ci` — CI 上传 OTA,scope 可为 upload / download / full

任何列表接口在 SQL 层就 JOIN 权限表过滤,无权限的客户/项目根本不会出现在响应里。
每一次状态变更/上传/下载都写 `audit_logs`,带 IP / UA / actor。

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
│   │   │   │   ├── users.ts        # super_admin user CRUD
│   │   │   │   ├── customers.ts    # tenant CRUD
│   │   │   │   ├── projects.ts     # project CRUD (per customer)
│   │   │   │   ├── memberships.ts  # role grants (customer + project)
│   │   │   │   ├── api-tokens.ts   # device / CI tokens
│   │   │   │   ├── versions.ts     # version metadata (list/get/patch/delete)
│   │   │   │   ├── upload.ts       # multipart init/sign-part/complete/abort/sessions
│   │   │   │   ├── download.ts     # user grant + device 302 → R2 presigned
│   │   │   │   └── audit.ts        # log reader (scope-filtered)
│   │   │   ├── middleware/auth.ts  # requireUser / requireSuperAdmin
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
```

### 1. Worker 本地凭据

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# 编辑 .dev.vars,填入 JWT_SECRET (openssl rand -hex 32) 和你的 R2 S3 keys。
# 注意:这套 .dev.vars 用于 `npm run dev`(wrangler)——它模拟 Cloudflare、没有本地磁盘,
# 所以必须连真的 R2 桶(本地 wrangler 不能模拟 R2 multipart S3 endpoint)。
# 推荐另起一个开发用桶,如 qota-ota-dev,wrangler.toml 里改 R2_BUCKET_NAME。
#
# 想零依赖本地开发?用 `npm run dev:node`(Node 运行时),不填 S3 即默认用本地文件夹,
# 完全不需要 R2/MinIO。详见 DEPLOY.md。
```

### 2. R2 桶 + S3 凭据

```bash
# 创建桶(若还没建)
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

### 3. D1 + 迁移 + 种入第一个 super_admin

```bash
npm run db:migrate:local

ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='change-me-now' ADMIN_NAME='Root' \
  npm run -w apps/worker seed -- --local
```

### 4. 启动

```bash
npm run dev   # Worker 8787 + Vite 5173
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

> **推荐:Cloudflare Pages + 连 Git 自动部署。** 项目已配好单一 Pages 项目模式——
> 前端静态资源 + `functions/api/[[route]].ts`(把现有 Hono API 跑成 Pages Functions)
> **同域**,在 Pages 控制台「连接 Git 仓库」后 **每次 push 自动部署**,首次访问自动建管理员。
> 完整步骤见 [DEPLOY.md](DEPLOY.md) 的 *Option B*。下面是「独立 Worker + Pages」的手动方式(Option C)。

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

## 上传协议(参考)

每一步都是 JSON over `Authorization: Bearer <jwt>`(or CI api_token with scope upload):

| Step | Request | Notes |
| --- | --- | --- |
| `POST /api/upload/init` | `{ projectId, filename, totalSize, version, releaseChannel?, expectedSha256?, partSizeHint?, notes?, isMandatory?, minVersion?, maxVersion?, rolloutPercentage? }` | Worker 用 R2 S3 endpoint 调 CreateMultipartUpload,返回 `sessionId/uploadId/key/partSize/partCount/uploadedParts`。 |
| `POST /api/upload/sign-part` | `{ sessionId, partNumber }` | 返回 10min 短期 presigned PUT URL。 |
| `PUT <presigned url>` | 二进制分片 | 客户端直传 R2。响应 header `ETag` 必须能读到 → 检查 CORS。 |
| `POST /api/upload/complete` | `{ sessionId, parts:[{partNumber, etag, size}], sha256 }` | Worker CompleteMultipartUpload + HEAD 校验 + 写 `versions(status=ready)`。 |
| `POST /api/upload/abort` | `{ sessionId }` | AbortMultipartUpload + 标记 session aborted。 |
| `GET  /api/upload/sessions?projectId=N` | — | 列出本项目的 session,可用 `?status=in_progress` 过滤。 |
| `GET  /api/upload/sessions/:id` | — | 详情 + 已上传分片列表,前端可基于此恢复。 |

## 数据布局

R2 key:`<customer_code>/<project_code>/<channel>/<version>/<filename>`
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
