#!/bin/bash
# Publishes this folder to GitHub Pages as <your-username>.github.io/engraver-board
# Run from Terminal:  bash ~/Downloads/Ivelisse/engraver-board/publish.sh
set -e
cd "$(dirname "$0")"
REPO=engraver-board
OWNER=$(gh api user -q .login)
ID=$(gh api user -q .id)
[ -d .git ] || git init -q -b main
git add -A
git -c user.name="$OWNER" -c user.email="$ID+$OWNER@users.noreply.github.com" commit -qm "Update Ivelisse Board" || echo "(no changes to commit)"
if git remote get-url origin >/dev/null 2>&1; then
  git push -q origin main
else
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi
gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true
echo ""
echo "Done. Live in about a minute at: https://$OWNER.github.io/$REPO/"
