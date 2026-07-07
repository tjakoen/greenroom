#!/usr/bin/env bash
# Friendly runner. No coding needed:  ./run.sh   (or:  npm run menu)
set -e

cd "$(dirname "$0")"

# Make sure a .env exists (logins).
if [ ! -f .env ]; then
  echo "First run: creating your private .env from the template..."
  cp .env.example .env
  echo ""
  echo ">> Open the .env file, paste in the logins, save, then run this again."
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
echo "Which environment do you want to test?"
i=1
for e in "${ENVS[@]}"; do
  echo "  $i) $e"
  i=$((i + 1))
done
echo ""
read -rp "Type a number and press Enter: " choice

if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#ENVS[@]} ]; then
  echo "Didn't understand '$choice'. Run again and type one of the numbers above."
  exit 1
fi
NAME="${ENVS[$((choice - 1))]}"

echo ""
echo "Running tests against $NAME... (a summary prints below when done)"
echo ""

# Run every test against the chosen environment. Don't stop on failures — we
# still want the report.
set +e
TEST_ENV="$NAME" npx playwright test
STATUS=$?
set -e

echo ""
echo "-------------------------------------------------------------"
if [ $STATUS -eq 0 ]; then
  echo "All tests PASSED."
else
  echo "Some tests FAILED. Open the report below to see what and why."
fi
echo "Opening the visual report... look for a 'Open in Browser' popup."
echo "(Press Ctrl+C in this terminal when you're done looking.)"
echo "-------------------------------------------------------------"
echo ""

# Serve the report locally (opens in your browser).
npx playwright show-report --port 9323
