export const API_DOCS_MARKDOWN = `# ci-transcode API

Asynchronous AV1 software transcoding powered by GitHub Actions + ffmpeg. All video files
live in a private R2 bucket; every read/write goes through a short-lived presigned URL.
Neither this service nor CI records or emits the original filename or any video metadata.

## Call flow

1. **Create a job** — \`POST /jobs\` to get a \`jobId\`, a \`token\` (keep it safe — it's the only credential for everything that follows), and a presigned \`uploadUrl\`.
2. **Upload the source directly** — \`PUT\` the binary content to \`uploadUrl\` (bypasses this service entirely).
3. **Commit the job** — \`POST /jobs/{jobId}/commit\`; the server verifies the upload, queues for a concurrency slot (max 10 parallel), and triggers GitHub Actions.
4. **Poll status** — \`GET /jobs/{jobId}\` to watch the stages: queued → dispatching → downloading → transcoding → uploading → done/failed.
5. **Fetch the result** — once status is \`done\`, \`GET /jobs/{jobId}/result\` returns a presigned download URL.

> Every \`/jobs/*\` endpoint except job creation requires \`Authorization: Bearer <token>\`. The token is returned only once, at creation — don't leak it; it's the sole credential for that job.

## POST /jobs

Create a new job and request an upload URL.

| Body (JSON, optional) | Description |
|---|---|
| \`crf\` | Integer 0-63, default 40 |
| \`preset\` | Integer 0-13 (SVT-AV1 numeric preset: 0 = slowest/best quality, 13 = fastest), default 4 |

Out-of-range values are clamped, not rejected. The response's \`crf\`/\`preset\` fields report the
values actually stored -- check them if you want to confirm what was accepted.

\`\`\`
curl -X POST https://your-worker.example.workers.dev/jobs \\
  -H 'content-type: application/json' \\
  -d '{"crf": 32, "preset": 4}'
\`\`\`

\`\`\`json
{
  "jobId": "a1b2c3...",
  "token": "xxxxx...",
  "uploadUrl": "https://...r2.cloudflarestorage.com/...",
  "uploadMethod": "PUT",
  "expiresAt": "2026-09-05T14:00:00.000Z",
  "crf": 32,
  "preset": 4
}
\`\`\`

## PUT <uploadUrl>

PUT the source video's binary content directly to the \`uploadUrl\` returned above (a presigned R2 URL, valid for 1 hour).

\`\`\`
curl -X PUT "$UPLOAD_URL" --data-binary @input.mp4
\`\`\`

## POST /jobs/{jobId}/commit

Confirm the upload is complete and enqueue the job for transcoding.

\`\`\`
curl -X POST https://your-worker.example.workers.dev/jobs/$JOB_ID/commit \\
  -H "Authorization: Bearer $TOKEN"
\`\`\`

\`\`\`json
{ "jobId": "a1b2c3...", "status": "dispatching", "queued": false }
\`\`\`

## GET /jobs/{jobId}

Query job status (coarse-grained stage only — no duration/codec or other video metadata).

\`\`\`
curl https://your-worker.example.workers.dev/jobs/$JOB_ID \\
  -H "Authorization: Bearer $TOKEN"
\`\`\`

\`\`\`json
{
  "jobId": "a1b2c3...",
  "status": "transcoding",
  "createdAt": "...", "updatedAt": "...", "expiresAt": "...",
  "sourceBytes": 186662455, "resultBytes": null,
  "crf": 32, "preset": 4,
  "error": null
}
\`\`\`

## GET /jobs/{jobId}/result

Once the job is \`done\`, get a one-time presigned download URL for the result (valid for 1 hour).

\`\`\`
curl https://your-worker.example.workers.dev/jobs/$JOB_ID/result \\
  -H "Authorization: Bearer $TOKEN"
\`\`\`

\`\`\`json
{ "resultUrl": "https://...", "expiresIn": 3600 }
\`\`\`

## State machine

| status | Meaning |
|---|---|
| \`awaiting_upload\` | Job created, waiting for the source file to be uploaded |
| \`queued\` | Committed, waiting for a free concurrency slot (max 10) |
| \`dispatching\` | Triggering GitHub Actions |
| \`downloading\` | CI is pulling the source from R2 |
| \`transcoding\` | ffmpeg is encoding to AV1 |
| \`uploading\` | CI is uploading the result to R2 |
| \`done\` | Finished, result available |
| \`failed\` | Failed, see the \`error\` field |
| \`expired\` | Past TTL (1 day by default) or evicted due to quota (LRU) |

## Privacy and security

- The R2 bucket is fully private; all reads/writes go through short-lived (1 hour by default) presigned URLs.
- Object keys are random IDs and never contain the original filename.
- CI only ever receives the job id, R2 keys, crf, and preset. ffmpeg's own output and ffprobe metadata are never logged or reported back — nothing about the video's content appears in CI logs.
- The source file is deleted from R2 immediately once the job terminates (success or failure).
- Result files expire automatically after 1 day by default; when storage exceeds the 5GB quota, the least-recently-accessed objects are evicted first (LRU).
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal Markdown -> HTML renderer, just enough for this doc's own subset (headings, lists,
 * tables, fenced code blocks, blockquotes, bold, inline code, paragraphs). Not a general parser. */
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(
        `<pre><code${lang ? ` class="lang-${lang}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      out.push(`<div class="note">${inline(buf.join(" "))}</div>`);
      continue;
    }

    if (/^\|/.test(line)) {
      const rows: string[][] = [];
      const isSeparatorRow = (l: string) =>
        l
          .slice(1, -1)
          .split("|")
          .every((cell) => /^\s*:?-+:?\s*$/.test(cell));

      while (i < lines.length && /^\|/.test(lines[i])) {
        if (!isSeparatorRow(lines[i])) {
          rows.push(
            lines[i]
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim()),
          );
        }
        i++;
      }
      const [header, ...body] = rows;
      out.push("<table>");
      out.push("<tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr>");
      for (const r of body) {
        out.push("<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      out.push("</table>");
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        buf.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      out.push("<ol>" + buf.map((li) => `<li>${inline(li)}</li>`).join("") + "</ol>");
      continue;
    }

    if (/^-\s/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^-\s/.test(lines[i])) {
        buf.push(lines[i].replace(/^-\s/, ""));
        i++;
      }
      out.push("<ul>" + buf.map((li) => `<li>${inline(li)}</li>`).join("") + "</ul>");
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
    i++;
  }

  return out.join("\n");
}

export function renderDocsHtml(): string {
  return `<!doctype html>
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
  .note { border-left: 3px solid #8884; padding: .3em 1em; margin: 1em 0; opacity: .85; }
  ol > li { margin-bottom: .4em; }
  .md-link { float: right; font-size: .8em; opacity: .7; }
</style>
</head>
<body>
<p class="md-link"><a href="/docs.md">View as Markdown</a></p>
${renderMarkdown(API_DOCS_MARKDOWN)}
</body>
</html>`;
}
