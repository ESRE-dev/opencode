#!/usr/bin/env bash
set -euo pipefail

echo "=== Fetching upstream ==="
git fetch upstream

echo "=== Resetting dev to upstream/dev ==="
git switch dev
git reset --hard upstream/dev

echo "=== Rebasing local/* branches ==="
for branch in $(git branch --list 'local/*' --format='%(refname:short)' | sort); do
  echo "--- Rebasing $branch ---"
  git switch "$branch"
  if ! git rebase dev; then
    echo "CONFLICT in $branch — resolve manually, then run: git rebase --continue"
    exit 1
  fi
done

echo "=== Rebuilding local-dev ==="
git switch -C local-dev dev
for branch in $(git branch --list 'local/*' --format='%(refname:short)' | sort); do
  echo "--- Merging $branch ---"
  if ! git merge --no-ff "$branch" -m "integrate: $branch"; then
    echo "CONFLICT merging $branch into local-dev — resolve manually"
    exit 1
  fi
done

echo "=== Switching back to dev ==="
git switch dev

echo "=== Done. local-dev is ready. ==="
echo "Run 'git push origin dev --force-with-lease' to sync the fork."
