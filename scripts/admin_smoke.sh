#!/bin/sh
# Smoke test for the deployed Supabase `admin` Edge Function.
# Run after each deploy to confirm PIN gate + key actions still work end-to-end.
#
#   sh ./scripts/admin_smoke.sh
#
# Override the project URL or PIN via env vars:
#   ADMIN_URL=https://<ref>.supabase.co/functions/v1/admin
#   ADMIN_PIN=200006
#
# Exit code: 0 if every assertion passes, 1 if any check fails (or the
# network call exits non-zero).

set -u

ADMIN_URL="${ADMIN_URL:-https://ljvdaajfbkqeodglghwn.supabase.co/functions/v1/admin}"
ADMIN_PIN="${ADMIN_PIN:-200006}"

pass=0
fail=0

assert_eq() {
  expected="$1"; actual="$2"; label="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS  $label  ($actual)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $label  expected=$expected actual=$actual"
    fail=$((fail + 1))
  fi
}

call() {
  payload="$1"
  curl -s --max-time 30 -X POST "$ADMIN_URL" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

call_with_status() {
  payload="$1"
  curl -s --max-time 30 -o /tmp/admin_smoke.out -w "%{http_code}" \
    -X POST "$ADMIN_URL" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

echo "[1/7] PIN gate — wrong PIN should be 403 / 'Incorrect PIN'"
status=$(call_with_status "{\"action\":\"verifyPin\",\"pin\":\"000000\"}")
assert_eq "403" "$status" "wrong-PIN HTTP status"
err=$(cat /tmp/admin_smoke.out | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
assert_eq "Incorrect PIN" "$err" "wrong-PIN error string"

echo "[2/7] verifyPin correct PIN → 200 {\"ok\":true,...}"
status=$(call_with_status "{\"action\":\"verifyPin\",\"pin\":\"$ADMIN_PIN\"}")
assert_eq "200" "$status" "verifyPin HTTP status"
body=$(cat /tmp/admin_smoke.out)
case "$body" in
  *'"ok":true'*) echo "  PASS  verifyPin body shape"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  verifyPin body shape (raw=$body)"; fail=$((fail + 1)) ;;
esac

echo "[3/7] unknown action → 404"
status=$(call_with_status "{\"action\":\"bogusAction\",\"pin\":\"$ADMIN_PIN\"}")
assert_eq "404" "$status" "unknown-action HTTP status"

echo "[4/7] getDashboard → 200, includes settings + chats + sources"
body=$(call "{\"action\":\"getDashboard\",\"pin\":\"$ADMIN_PIN\"}")
case "$body" in
  *'"ok":true'*) echo "  PASS  getDashboard returned ok envelope"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  getDashboard envelope (raw=$body)"; fail=$((fail + 1)) ;;
esac
case "$body" in
  *'"settings"'*'"chats"'*'"sources"'*) echo "  PASS  getDashboard payload has settings/chats/sources"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  getDashboard payload missing expected fields"; fail=$((fail + 1)) ;;
esac

echo "[5/7] listTranslationKeys → 200, includes geminiUsage array"
body=$(call "{\"action\":\"listTranslationKeys\",\"pin\":\"$ADMIN_PIN\"}")
case "$body" in
  *'"geminiUsage"'*) echo "  PASS  listTranslationKeys carries geminiUsage"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  listTranslationKeys payload"; fail=$((fail + 1)) ;;
esac

echo "[6/7] listTranslationModels → 200, includes gemini-3.6-flash"
body=$(call "{\"action\":\"listTranslationModels\",\"pin\":\"$ADMIN_PIN\"}")
case "$body" in
  *'gemini-3.6-flash'*) echo "  PASS  listTranslationModels contains gemini-3.6-flash"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  listTranslationModels payload (raw=$body)"; fail=$((fail + 1)) ;;
esac

echo "[7/7] bots round-trip: create → toggle categories (no name) → delete"
created=$(call "{\"action\":\"saveBot\",\"pin\":\"$ADMIN_PIN\",\"name\":\"smoke-bot\",\"token\":\"123456:SMOKE\"}")
case "$created" in
  *'"ok":true'*) echo "  PASS  saveBot created smoke-bot"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  saveBot create (raw=$created)"; fail=$((fail + 1)) ;;
esac
bot_id=$(call "{\"action\":\"getDashboard\",\"pin\":\"$ADMIN_PIN\"}" | sed -n 's/.*"id":"\([0-9a-f-]*\)","name":"smoke-bot".*/\1/p' | head -1)
if [ -n "$bot_id" ]; then
  echo "  PASS  found smoke-bot id $bot_id"; pass=$((pass + 1))
else
  echo "  FAIL  smoke-bot not found in getDashboard"; fail=$((fail + 1))
fi
toggled=$(call "{\"action\":\"saveBot\",\"pin\":\"$ADMIN_PIN\",\"id\":\"$bot_id\",\"categories\":[\"iraq\",\"oil\"]}")
case "$toggled" in
  *'"ok":true'*) echo "  PASS  saveBot categories toggle without name"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  saveBot categories toggle (raw=$toggled)"; fail=$((fail + 1)) ;;
esac
stored=$(call "{\"action\":\"getDashboard\",\"pin\":\"$ADMIN_PIN\"}")
case "$stored" in
  *'"categories":["iraq","oil"]'*) echo "  PASS  categories persisted"; pass=$((pass + 1)) ;;
  *) echo "  FAIL  categories not persisted (raw=$stored)"; fail=$((fail + 1)) ;;
esac
if [ -n "$bot_id" ]; then
  removed=$(call "{\"action\":\"deleteBot\",\"pin\":\"$ADMIN_PIN\",\"id\":\"$bot_id\"}")
  case "$removed" in
    *'"ok":true'*) echo "  PASS  deleteBot removed smoke-bot"; pass=$((pass + 1)) ;;
    *) echo "  FAIL  deleteBot (raw=$removed)"; fail=$((fail + 1)) ;;
  esac
fi

echo
echo "Passed: $pass   Failed: $fail"
[ "$fail" = "0" ] && exit 0 || exit 1
