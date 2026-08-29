#!/usr/bin/env bash
set -euo pipefail

remote_host="${1:-vr-mayos}"
remote_root="${2:-/opt/multilinguum}"

if [[ ! "$remote_host" =~ ^[A-Za-z0-9._@:-]+$ ]]; then
  echo "Remote host contains unsupported characters." >&2
  exit 2
fi
if [[ ! "$remote_root" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "Remote root must be a simple absolute path." >&2
  exit 2
fi

printf 'Paste the Multilinguum OpenAI project key (input is hidden): '
IFS= read -r -s openai_key
printf '\n'

if [[ ! "$openai_key" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]]; then
  unset openai_key
  echo "Input does not look like an OpenAI API project key." >&2
  exit 2
fi

printf '%s\n' "$openai_key" | ssh "$remote_host" \
  "cd '$remote_root' && node scripts/store-openai-key.mjs .env"
unset openai_key

ssh "$remote_host" "cd '$remote_root' && docker compose up -d --force-recreate processor"

ssh "$remote_host" "cd '$remote_root' && bash -s" <<'REMOTE_CHECK'
set -euo pipefail
for attempt in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:4310/health >/dev/null; then
    set -a
    . ./.env
    set +a
    node --input-type=module -e '
      const response = await fetch("http://127.0.0.1:4310/api/preflight", {
        headers: { authorization: `Bearer ${process.env.PROCESSOR_CONTROL_TOKEN}` },
      });
      if (!response.ok) throw new Error(`Preflight failed: ${response.status}`);
      const preflight = await response.json();
      if (!preflight.openai?.configured) throw new Error("Processor did not load the OpenAI key.");
      console.log(JSON.stringify({
        processor: "healthy",
        openaiConfigured: true,
        realtimeTranslationModel: preflight.openai.realtimeTranslationModel,
        transcriptionModel: preflight.openai.transcriptionModel,
        voiceWorker: preflight.voiceWorker,
      }, null, 2));
    '
    exit 0
  fi
  sleep 2
done
echo "Processor did not become healthy within 40 seconds." >&2
exit 1
REMOTE_CHECK
