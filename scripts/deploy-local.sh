#!/bin/sh
# Ship Axon from this machine: run the self-check over the exact code being shipped, let it repair what it can
# (each repair kept only if the type check and the full test suite still pass with it, otherwise put back),
# commit the kept repairs and then the record in autonomy/, then upload to Railway. The record on /autonomy is
# then always the pass over what is live.   npm run deploy
set -e
cd "$(dirname "$0")/.."
if git diff --quiet && git diff --cached --quiet; then
  node scripts/autonomy.mjs --fix
  # exactly the files the kept repairs touched, as the pass recorded them
  FIXED=$(node -e 'const r=JSON.parse(require("fs").readFileSync("autonomy/latest.json","utf8"));const s=new Set();for(const c of r.changes||[])if(c.status==="applied")for(const f of c.files||[])s.add(f);process.stdout.write([...s].join(" "))')
  if [ -n "$FIXED" ]; then
    git add -- $FIXED
    git -c user.name="Seierk" -c user.email="358833923+SeierkDeveloper@users.noreply.github.com" \
      commit -q -m "chore(autonomy): self-repair $(date -u +%Y-%m-%d)" -- $FIXED
  fi
else
  # Repairs are committed on their own, so they only run on a clean tree: with edits of yours in the way,
  # a repair commit could carry them too. Check only, this time.
  echo "uncommitted changes: running the self-check without repairs"
  node scripts/autonomy.mjs
fi
if ! git diff --quiet -- autonomy/; then
  git add autonomy/
  git -c user.name="Seierk" -c user.email="358833923+SeierkDeveloper@users.noreply.github.com" \
    commit -q -m "chore(autonomy): self-check pass $(date -u +%Y-%m-%d)"
fi
railway up --service Axon --detach
