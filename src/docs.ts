export const API_DOCS_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ci-transcode API</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 1.6em; margin-bottom: .2em; }
  h2 { margin-top: 2.2em; border-bottom: 1px solid #8884; padding-bottom: .3em; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: #80808014; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  code { background: #80808014; padding: .15em .4em; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: .8em 0; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #8884; vertical-align: top; }
  .method { font-weight: 700; }
  .m-post { color: #1a7f37; }
  .m-get { color: #0969da; }
  .note { border-left: 3px solid #8884; padding: .3em 1em; margin: 1em 0; opacity: .85; }
  .flow li { margin-bottom: .4em; }
</style>
</head>
<body>

<h1>ci-transcode API</h1>
<p>基于 GitHub Actions + ffmpeg 的异步 AV1 软件转码服务。所有视频存储在私有 R2 桶中，
读写均通过短时效预签名 URL 完成；服务端与 CI 均不记录、不输出原始文件名或视频元数据。</p>

<h2>调用流程</h2>
<ol class="flow">
  <li><b>创建任务</b> — <code>POST /jobs</code>，获得 <code>jobId</code>、<code>token</code>（务必妥善保管，是后续所有操作的唯一凭证）与一个预签名 <code>uploadUrl</code>。</li>
  <li><b>直传源文件</b> — 客户端直接 <code>PUT</code> 二进制内容到 <code>uploadUrl</code>（不经过本服务）。</li>
  <li><b>提交转码</b> — <code>POST /jobs/{jobId}/commit</code>，服务端校验上传完成、做并发排队（最多 10 并行），触发 GitHub Actions。</li>
  <li><b>轮询状态</b> — <code>GET /jobs/{jobId}</code> 查看阶段：queued → dispatching → downloading → transcoding → uploading → done/failed。</li>
  <li><b>获取结果</b> — 状态为 <code>done</code> 后，<code>GET /jobs/{jobId}/result</code> 返回一次性预签名下载 URL。</li>
</ol>

<div class="note">所有 <code>/jobs/*</code> 接口（创建除外）都需要 <code>Authorization: Bearer &lt;token&gt;</code>。token 只在创建时返回一次，请勿泄露；它是访问该任务的唯一凭证。</div>

<h2>POST /jobs</h2>
<p>创建一个新任务并申请上传地址。</p>
<table>
<tr><th>Body (JSON, 可选)</th><th>说明</th></tr>
<tr><td><code>crf</code></td><td>整数 0-63，默认 40</td></tr>
<tr><td><code>preset</code></td><td>ultrafast..veryslow，默认 slow</td></tr>
</table>
<pre><code>curl -X POST https://your-worker.example.workers.dev/jobs \\
  -H 'content-type: application/json' \\
  -d '{"crf": 32, "preset": "slow"}'</code></pre>
<pre><code>{
  "jobId": "a1b2c3...",
  "token": "xxxxx...",
  "uploadUrl": "https://...r2.cloudflarestorage.com/...",
  "uploadMethod": "PUT",
  "expiresAt": "2026-09-05T14:00:00.000Z"
}</code></pre>

<h2>PUT &lt;uploadUrl&gt;</h2>
<p>将源视频二进制内容直接 PUT 到上一步返回的 <code>uploadUrl</code>（R2 预签名地址，1 小时内有效）。</p>
<pre><code>curl -X PUT "$UPLOAD_URL" --data-binary @input.mp4</code></pre>

<h2><span class="method m-post">POST</span> /jobs/{jobId}/commit</h2>
<p>确认上传完成，进入转码队列。</p>
<pre><code>curl -X POST https://your-worker.example.workers.dev/jobs/$JOB_ID/commit \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
<pre><code>{ "jobId": "a1b2c3...", "status": "dispatching", "queued": false }</code></pre>

<h2><span class="method m-get">GET</span> /jobs/{jobId}</h2>
<p>查询任务状态（粗粒度阶段，不含视频时长/编码等元数据）。</p>
<pre><code>curl https://your-worker.example.workers.dev/jobs/$JOB_ID \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
<pre><code>{
  "jobId": "a1b2c3...",
  "status": "transcoding",
  "createdAt": "...", "updatedAt": "...", "expiresAt": "...",
  "crf": 32, "preset": "slow",
  "error": null
}</code></pre>

<h2><span class="method m-get">GET</span> /jobs/{jobId}/result</h2>
<p>任务 <code>done</code> 后获取结果的一次性预签名下载地址（1 小时有效）。</p>
<pre><code>curl https://your-worker.example.workers.dev/jobs/$JOB_ID/result \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
<pre><code>{ "resultUrl": "https://...", "expiresIn": 3600 }</code></pre>

<h2>状态机</h2>
<table>
<tr><th>status</th><th>含义</th></tr>
<tr><td><code>awaiting_upload</code></td><td>已创建，等待源文件上传</td></tr>
<tr><td><code>queued</code></td><td>已提交，等待并发槽位（上限 10）</td></tr>
<tr><td><code>dispatching</code></td><td>正在触发 GitHub Actions</td></tr>
<tr><td><code>downloading</code></td><td>CI 正从 R2 拉取源文件</td></tr>
<tr><td><code>transcoding</code></td><td>ffmpeg 正在编码 AV1</td></tr>
<tr><td><code>uploading</code></td><td>CI 正上传结果到 R2</td></tr>
<tr><td><code>done</code></td><td>完成，可获取结果</td></tr>
<tr><td><code>failed</code></td><td>失败，见 <code>error</code> 字段</td></tr>
<tr><td><code>expired</code></td><td>超过 TTL（默认 1 天）或因配额被 LRU 驱逐</td></tr>
</table>

<h2>隐私与安全</h2>
<ul>
  <li>R2 桶完全私有，所有读写仅通过短时效（默认 1 小时）预签名 URL 进行。</li>
  <li>对象 key 为随机 ID，不包含原始文件名。</li>
  <li>CI 只接收 job id / R2 key / crf / preset，ffmpeg 输出与 ffprobe 元数据不会被记录或回传，日志中不包含任何视频内容信息。</li>
  <li>源文件在转码完成（成功或失败）后立即从 R2 删除。</li>
  <li>结果文件默认 1 天后自动过期删除；存储超过 5GB 配额时按最久未访问（LRU）优先驱逐。</li>
</ul>

</body>
</html>`;
