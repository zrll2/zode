#!/bin/bash
# One-time setup and deploy of the push service to Vercel. Run it yourself: it stores the APNs key and a fresh
# server key as Vercel environment variables, then deploys to production.
#   bash push-service/deploy.sh <APNs .p8 file> <APNs key id> <Apple team id> [topic]
# Example: bash push-service/deploy.sh ~/.private_keys/AuthKey_9T7LPTB874.p8 9T7LPTB874 XP5Q8LPH52 sg.comex.zode
set -euo pipefail
cd "$(dirname "$0")"
P8="${1:?path to the APNs .p8 key}"; KEY_ID="${2:?APNs key id}"; TEAM="${3:?Apple team id}"; TOPIC="${4:-sg.comex.zode}"
[ -f "$P8" ] || { echo "No such file: $P8" >&2; exit 1; }
vercel link --yes --project zode-push
for name in PUSH_SERVER_KEY APNS_KEY APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC; do vercel env rm "$name" production --yes >/dev/null 2>&1 || true; done
openssl rand -base64 32 | tr -d '\n' | vercel env add PUSH_SERVER_KEY production
vercel env add APNS_KEY production < "$P8"
printf '%s' "$KEY_ID" | vercel env add APNS_KEY_ID production
printf '%s' "$TEAM" | vercel env add APNS_TEAM_ID production
printf '%s' "$TOPIC" | vercel env add APNS_TOPIC production
vercel --prod --yes
rm -f .env.local
echo "Now check: curl -s https://zode-push.vercel.app/api/health"
