export const API_DOCS_HTML = `<!doctype html>
<html lang="en">
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
<p>Asynchronous AV1 software transcoding powered by GitHub Actions + ffmpeg. All video files
live in a private R2 bucket; every read/write goes through a short-lived presigned URL.
Neither this service nor CI records or emits the original filename or any video metadata.</p>

<h2>Call flow</h2>
<ol class="flow">
  <li><b>Create a job</b> — <code>POST /jobs</code> to get a <code>jobId</code>, a <code>token</code> (keep it safe — it's the only credential for everything that follows), and a presigned <code>uploadUrl</code>.</li>
  <li><b>Upload the source directly</b> — <code>PUT</code> the binary content to <code>uploadUrl</code> (bypasses this service entirely).</li>
  <li><b>Commit the job</b> — <code>POST /jobs/{jobId}/commit</code>; the server verifies the upload, queues for a concurrency slot (max 10 parallel), and triggers GitHub Actions.</li>
  <li><b>Poll status</b> — <code>GET /jobs/{jobId}</code> to watch the stages: queued → dispatching → downloading → transcoding → uploading → done/failed.</li>
  <li><b>Fetch the result</b> — once status is <code>done</code>, <code>GET /jobs/{jobId}/result</code> returns a presigned download URL.</li>
</ol>

<div class="note">Every <code>/jobs/*</code> endpoint except job creation requires <code>Authorization: Bearer &lt;token&gt;</code>. The token is returned only once, at creation — don't leak it; it's the sole credential for that job.</div>

<h2>POST /jobs</h2>
<p>Create a new job and request an upload URL.</p>
<table>
<tr><th>Body (JSON, optional)</th><th>Description</th></tr>
<tr><td><code>crf</code></td><td>Integer 0-63, default 40</td></tr>
<tr><td><code>preset</code></td><td>Integer 0-13 (SVT-AV1 numeric preset: 0 = slowest/best quality, 13 = fastest), default 4</td></tr>
</table>
<pre><code>curl -X POST https://your-worker.example.workers.dev/jobs \\
  -H 'content-type: application/json' \\
  -d '{"crf": 32, "preset": 4}'</code></pre>
<pre><code>{
  "jobId": "a1b2c3...",
  "token": "xxxxx...",
  "uploadUrl": "https://...r2.cloudflarestorage.com/...",
  "uploadMethod": "PUT",
  "expiresAt": "2026-09-05T14:00:00.000Z"
}</code></pre>

<h2>PUT &lt;uploadUrl&gt;</h2>
<p>PUT the source video's binary content directly to the <code>uploadUrl</code> returned above (a presigned R2 URL, valid for 1 hour).</p>
<pre><code>curl -X PUT "$UPLOAD_URL" --data-binary @input.mp4</code></pre>

<h2><span class="method m-post">POST</span> /jobs/{jobId}/commit</h2>
<p>Confirm the upload is complete and enqueue the job for transcoding.</p>
<pre><code>curl -X POST https://your-worker.example.workers.dev/jobs/$JOB_ID/commit \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
<pre><code>{ "jobId": "a1b2c3...", "status": "dispatching", "queued": false }</code></pre>

<h2><span class="method m-get">GET</span> /jobs/{jobId}</h2>
<p>Query job status (coarse-grained stage only — no duration/codec or other video metadata).</p>
<pre><code>curl https://your-worker.example.workers.dev/jobs/$JOB_ID \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
<pre><code>{
  "jobId": "a1b2c3...",
  "status": "transcoding",
  "createdAt": "...", "updatedAt": "...", "expiresAt": "...",
  "sourceBytes": 186662455, "resultBytes": null,
  "crf": 32, "preset": 4,
  "error": null
}</code></pre>

<h2><span class="method m-get">GET</span> /jobs/{jobId}/result</h2>
<p>Once the job is <code>done</code>, get a one-time presigned download URL for the result (valid for 1 hour).</p>
<pre><code>curl https://your-worker.example.workers.dev/jobs/$JOB_ID/result \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
<pre><code>{ "resultUrl": "https://...", "expiresIn": 3600 }</code></pre>

<h2>State machine</h2>
<table>
<tr><th>status</th><th>Meaning</th></tr>
<tr><td><code>awaiting_upload</code></td><td>Job created, waiting for the source file to be uploaded</td></tr>
<tr><td><code>queued</code></td><td>Committed, waiting for a free concurrency slot (max 10)</td></tr>
<tr><td><code>dispatching</code></td><td>Triggering GitHub Actions</td></tr>
<tr><td><code>downloading</code></td><td>CI is pulling the source from R2</td></tr>
<tr><td><code>transcoding</code></td><td>ffmpeg is encoding to AV1</td></tr>
<tr><td><code>uploading</code></td><td>CI is uploading the result to R2</td></tr>
<tr><td><code>done</code></td><td>Finished, result available</td></tr>
<tr><td><code>failed</code></td><td>Failed, see the <code>error</code> field</td></tr>
<tr><td><code>expired</code></td><td>Past TTL (1 day by default) or evicted due to quota (LRU)</td></tr>
</table>

<h2>Privacy and security</h2>
<ul>
  <li>The R2 bucket is fully private; all reads/writes go through short-lived (1 hour by default) presigned URLs.</li>
  <li>Object keys are random IDs and never contain the original filename.</li>
  <li>CI only ever receives the job id, R2 keys, crf, and preset. ffmpeg's own output and ffprobe metadata are never logged or reported back — nothing about the video's content appears in CI logs.</li>
  <li>The source file is deleted from R2 immediately once the job terminates (success or failure).</li>
  <li>Result files expire automatically after 1 day by default; when storage exceeds the 5GB quota, the least-recently-accessed objects are evicted first (LRU).</li>
</ul>

</body>
</html>`;
