#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/sunilmathew/AgenticApplications/HomeOps"

ANON_KEY="$(grep '^VITE_SUPABASE_ANON_KEY=' "$ROOT/.env" | sed 's/^VITE_SUPABASE_ANON_KEY=//')"
CRON_SECRET="$(grep '^CRON_SECRET=' "$ROOT/supabase/functions/.env" | sed 's/^CRON_SECRET=//')"

if [[ -z "${ANON_KEY:-}" ]]; then
  echo "Missing VITE_SUPABASE_ANON_KEY in $ROOT/.env" >&2
  exit 1
fi

if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "Missing CRON_SECRET in $ROOT/supabase/functions/.env" >&2
  exit 1
fi

curl -sS -X POST "http://127.0.0.1:54321/functions/v1/server/cron/run-automations?limit=50" \
  -H "Content-Type: application/json" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "x-cron-secret: ${CRON_SECRET}" \
  --data '{}'

echo
