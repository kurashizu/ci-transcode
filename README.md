# ci-transcode

基于 Cloudflare Workers + Durable Objects + R2 + GitHub Actions 的异步 AV1 软件转码服务。

- 转码引擎：ffmpeg (libsvtav1)，可配置 `crf`（默认 40）、`preset`（默认 slow）
- 并行度：最多 10 个并行转码任务（Durable Object 原子计数）
- 存储：Cloudflare R2，5GB 配额，满时按 LRU 驱逐，任务默认 1 天 TTL
- 全程加密隐私：R2 桶私有（仅预签名 URL 读写），CI 不输出/不记录任何视频文件名或元数据
- API 文档：部署后访问 Worker 根路径 `/`

## 目录结构

```
src/
  index.ts                    Worker 入口，路由与 REST API
  docs.ts                     API 文档页（HTML，挂载在 / 和 /docs）
  types.ts                    共享类型定义
  util.ts                     随机 id/token、鉴权辅助
  r2sign.ts                   R2 (S3 兼容) 预签名 URL 生成
  github.ts                   repository_dispatch 调用封装
  durable-objects/
    job-registry.ts           全局协调器：任务状态、并发槽位、LRU/TTL 驱逐
.github/workflows/
  transcode.yml                CI: 下载源 -> ffmpeg 转码 -> 上传结果 -> 回调状态
scripts/
  e2e.sh                       端到端冒烟测试脚本
```

## 部署步骤

### 1. 创建 R2 桶

```bash
wrangler r2 bucket create ci-transcode-store
```

### 2. 创建 R2 API Token（用于预签名，S3 兼容凭证）

Cloudflare Dashboard → R2 → Manage R2 API Tokens → 创建一个具有该桶读写权限的 Token，
记录 **Account ID**、**Access Key ID**、**Secret Access Key**。

### 3. 准备 GitHub 仓库

本仓库自身就是 CI 端仓库（包含 `.github/workflows/transcode.yml`）。在仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|---|---|
| `INTERNAL_CALLBACK_SECRET` | 与 Worker 端相同的内部密钥，CI 用它认证回调/预签名请求 |
| `WORKER_BASE_URL` | 部署后的 Worker 根地址，如 `https://ci-transcode.xxx.workers.dev` |

### 4. 创建 GitHub PAT（供 Worker 触发 repository_dispatch）

Fine-grained PAT，仅需该仓库的 `Contents: Read and write` + `Metadata: Read-only` 权限
（repository_dispatch 需要 `contents: write` 等价权限）。

### 5. 配置 Worker Secrets

```bash
wrangler secret put GITHUB_TOKEN            # 上一步的 PAT
wrangler secret put GITHUB_OWNER            # 你的 GitHub 用户名/组织
wrangler secret put GITHUB_REPO             # 本仓库名
wrangler secret put INTERNAL_CALLBACK_SECRET # 与步骤 3 一致的随机字符串
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET_NAME          # ci-transcode-store
```

`wrangler.toml` 中的 `[vars]`（CRF/preset 默认值、并发上限、配额、TTL）为非敏感配置，可直接改仓库里的值。

### 6. 部署

```bash
npm install
npm run deploy
```

## 端到端测试

```bash
BASE_URL=https://ci-transcode.<subdomain>.workers.dev ./scripts/e2e.sh
```

脚本会：创建任务 → 生成一个 2 秒测试视频并 PUT 到预签名地址 → commit 触发 CI →
轮询状态直到 `done`/`failed` → 下载转码结果并校验文件存在。

## API 一览

见部署后的 `GET /` 页面，或直接读 `src/docs.ts`。核心流程：

```
POST /jobs                    -> { jobId, token, uploadUrl }
PUT  <uploadUrl>               (直传 R2)
POST /jobs/{id}/commit         (Bearer token, 触发 CI)
GET  /jobs/{id}                (Bearer token, 查询状态)
GET  /jobs/{id}/result          (Bearer token, done 后拿预签名下载地址)
```

## 安全设计要点

- 每个任务的 `token` 由 32 字节 CSPRNG 生成，是访问该任务的唯一凭证，仅在创建时返回一次。
- R2 对象 key 全部是随机 ID，不含原始文件名；桶本身无公网直接访问权限。
- CI 通过 `/internal/*` 接口向 Worker 换取一次性预签名 URL 来读写 R2，R2 的长期凭证（Access Key/Secret）永远不出现在 CI 环境中。
- ffmpeg 执行时 `-loglevel error -nostats` 且 stdout/stderr 被丢弃，不落盘、不上传、不进日志；仅进程退出码决定成功/失败。
- 源文件在任务终止（成功或失败）后立即删除；结果文件默认 1 天后随 TTL 清理，存储超配额时按最久未访问优先驱逐。
