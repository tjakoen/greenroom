#!/usr/bin/env bash
# Record a test by clicking through the site. No coding.
#   ./record.sh   (or:  npm run record)
#
# A real browser opens on your screen. Click through what you want to test —
# every click is turned into a test file in tests/.
set -e

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> Created .env — open it, paste logins, save, then run this again."
  exit 0
fi

# Read the environment names from the single source of truth (config/urls.json).
ENVS=()
while IFS= read -r line; do
  [ -n "$line" ] && ENVS+=("$line")
done < <(node -e "const u=require('./config/urls.json');console.log(Object.keys(u).filter(k=>!k.startsWith('_')).join('\n'))")

if [ ${#ENVS[@]} -eq 0 ]; then
  echo "No environments defined yet. Start the app (npm start) -> Environments to add one."
  exit 1
fi

echo ""
echo "Which environment do you want to record against?"
i=1
for e in "${ENVS[@]}"; do
  echo "  $i) $e"
  i=$((i + 1))
done
read -rp "Type a number: " choice

if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#ENVS[@]} ]; then
  echo "Type one of the numbers above. Try again."
  exit 1
fi
ENV="${ENVS[$((choice - 1))]}"

# Read the site URL for that env from the single source of truth.
URL=$(node -e "console.log(require('./config/urls.json')['$ENV'].baseURL)")

echo ""
read -rp "Name this test (e.g. checkout-flow): " NAME
NAME=$(echo "$NAME" | tr ' ' '-' | tr -cd 'a-zA-Z0-9-')
[ -z "$NAME" ] && NAME="recorded"
OUT="tests/$NAME.spec.ts"

echo ""
echo "-------------------------------------------------------------"
echo "A browser will open. Click through what you want to test."
echo "Close the browser when done. Saved to: $OUT"
echo "-------------------------------------------------------------"
echo ""

TEST_ENV="$ENV" npx playwright codegen --target playwright-test -o "$OUT" "$URL"

echo ""
echo "Saved: $OUT"
echo "Run it from the app, or:  TEST_ENV=$ENV npx playwright test $OUT"
