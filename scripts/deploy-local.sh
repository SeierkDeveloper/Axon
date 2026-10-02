#!/bin/sh
# Ship Axon from this machine: run the self-check over the exact code being shipped, record it in autonomy/
# (committed, like the GitHub workflow does), then upload to Railway. The record on /autonomy is then always the
# pass over what is live.   npm run deploy
set -e
cd "$(dirname "$0")/.."
node scripts/autonomy.mjs
if ! git diff --quiet -- autonomy/; then
  git add autonomy/
  git -c user.name="Seierk" -c user.email="358833923+SeierkDeveloper@users.noreply.github.com" \
    commit -q -m "chore(autonomy): self-check pass $(date -u +%Y-%m-%d)"
fi
railway up --service Axon --detach
