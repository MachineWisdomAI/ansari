#!/usr/bin/env bash
# One first-load trial in a real host (#335). The person at the host follows the prompts; the script records the
# trial window and what they saw as one JSON line, which scripts/first-load-timeline.mjs joins with the server logs.
#
# Usage: bash scripts/first-load-trial.sh <host: claude|chatgpt> <deploy: fresh|aged> [case label]
# Output: test-results/first-load/trials.jsonl (git-ignored)
set -euo pipefail

host="${1:?host: claude or chatgpt}"
deploy="${2:?deploy: fresh (just redeployed) or aged (live for hours)}"
label="${3:-english-greeting}"
out="$(dirname "$0")/../test-results/first-load"
mkdir -p "$out"

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}
capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

step "In $host, open a NEW conversation with the Ansari Dev connector enabled. Do not send anything yet. Optional: open devtools on the page."
start="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
step "Send: Use Ansari Faithful Answers Dev to answer: What does \"assalamu alaikum\" mean? Please keep the answer brief."
capture first "What did the embed show first? (card / error / blank / none)"
retry="n-a"
if [ "$first" != "card" ]; then
  capture retry "Press the host's Retry / Try again once. What does it show now? (card / error / blank / none)"
fi
capture console "Optional: paste the [ansari-view] console lines from the card frame, or press Enter"
end="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

node -e 'const [host, deploy, label, start, end, first, retry, consoleLines] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({host, deploy, label, start, end, first, retry, console: consoleLines || undefined}) + "\n");' \
  "$host" "$deploy" "$label" "$start" "$end" "$first" "$retry" "$console" >> "$out/trials.jsonl"

printf '\n--- Recorded in %s ---\n' "$out/trials.jsonl"
tail -n 1 "$out/trials.jsonl"
