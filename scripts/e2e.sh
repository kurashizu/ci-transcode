#!/usr/bin/env bash
# End-to-end smoke test: create job -> upload tiny synthetic video -> commit -> poll -> download result.
#
# Usage:
#   BASE_URL=https://ci-transcode.<subdomain>.workers.dev ./scripts/e2e.sh
#
# Requires: curl, ffmpeg (only to synthesize a tiny local test clip; not used for the actual transcode).

set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL to your deployed worker origin}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-1800}"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

echo "== 1. generating tiny synthetic test clip =="
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc=size=160x120:duration=2:rate=10 \
    -f lavfi -i sine=frequency=1000:duration=2 \
    -c:v libx264 -preset ultrafast -c:a aac -shortest \
    "$work_dir/input.mp4"
else
  echo "ffmpeg not found locally; writing a dummy binary blob instead (transcode will fail, use only to test the API plumbing)"
  head -c 65536 /dev/urandom > "$work_dir/input.mp4"
fi

echo "== 2. POST /jobs =="
create_resp=$(curl -fsS -X POST "$BASE_URL/jobs" \
  -H 'content-type: application/json' \
  -d '{"crf": 40, "preset": "veryfast"}')
echo "$create_resp"

job_id=$(printf '%s' "$create_resp" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
token=$(printf '%s' "$create_resp" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
upload_url=$(printf '%s' "$create_resp" | grep -o '"uploadUrl":"[^"]*"' | cut -d'"' -f4)

if [ -z "$job_id" ] || [ -z "$token" ] || [ -z "$upload_url" ]; then
  echo "FAILED: could not parse jobId/token/uploadUrl from create response" >&2
  exit 1
fi
echo "jobId=$job_id"

echo "== 3. PUT source to R2 (presigned) =="
curl -fsS -X PUT "$upload_url" --data-binary @"$work_dir/input.mp4"
echo "upload ok"

echo "== 4. POST /jobs/$job_id/commit =="
commit_resp=$(curl -fsS -X POST "$BASE_URL/jobs/$job_id/commit" \
  -H "Authorization: Bearer $token")
echo "$commit_resp"

echo "== 5. polling status =="
elapsed=0
status=""
while [ "$elapsed" -lt "$MAX_WAIT_SECONDS" ]; do
  status_resp=$(curl -fsS "$BASE_URL/jobs/$job_id" -H "Authorization: Bearer $token")
  status=$(printf '%s' "$status_resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "[$elapsed s] status=$status"

  if [ "$status" = "done" ] || [ "$status" = "failed" ] || [ "$status" = "expired" ]; then
    break
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

if [ "$status" != "done" ]; then
  echo "FAILED: job did not complete successfully, final status=$status" >&2
  echo "$status_resp" >&2
  exit 1
fi

echo "== 6. GET result presigned URL =="
result_resp=$(curl -fsS "$BASE_URL/jobs/$job_id/result" -H "Authorization: Bearer $token")
echo "$result_resp"
result_url=$(printf '%s' "$result_resp" | grep -o '"resultUrl":"[^"]*"' | cut -d'"' -f4)

echo "== 7. downloading transcoded result =="
curl -fsS -o "$work_dir/output.av1.mkv" "$result_url"
ls -la "$work_dir/output.av1.mkv"

echo "E2E OK: $work_dir/output.av1.mkv"
