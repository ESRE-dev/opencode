#!/usr/bin/env bash
# rebase-branches.sh — Rebase local/* and pr/* branches onto upstream/dev.
#
# Usage: ./scripts/rebase-branches.sh [--dry-run]
#
# Reads .local-branches manifest for local/* branches. Auto-discovers
# local pr/* branches. Skips branches already up-to-date or checked out
# in other worktrees. Stops on first unresolvable conflict with recovery
# instructions.
#
# Requires: git rerere enabled (git config rerere.enabled true)
# Safe: never touches your active worktrees — uses a temp worktree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || git -C "$SCRIPT_DIR" rev-parse --git-common-dir | xargs dirname)"
# For worktrees, --show-toplevel gives the worktree root; we need the common git dir
GIT_COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --git-common-dir)"
MANIFEST="$SCRIPT_DIR/../.local-branches"
DRY_RUN=false
TEMP_WORKTREE=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

cleanup() {
  if [[ -n "$TEMP_WORKTREE" && -d "$TEMP_WORKTREE" ]]; then
    # Abort any in-progress rebase in the temp worktree
    git -C "$TEMP_WORKTREE" rebase --abort 2>/dev/null || true
    git -C "$TEMP_WORKTREE" worktree remove --force "$TEMP_WORKTREE" 2>/dev/null || true
    rm -rf "$TEMP_WORKTREE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Collect branches to rebase ---

branches=()

# Read manifest (local/* branches)
if [[ -f "$MANIFEST" ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"       # strip comments
    line="${line// /}"       # strip whitespace
    [[ -z "$line" ]] && continue
    branches+=("$line")
  done < "$MANIFEST"
else
  echo "WARNING: No .local-branches manifest found at $MANIFEST"
  echo "         Only pr/* branches will be rebased."
fi

# Auto-discover local pr/* branches
while IFS= read -r branch; do
  [[ -n "$branch" ]] && branches+=("$branch")
done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/pr/*' | sort)

if [[ ${#branches[@]} -eq 0 ]]; then
  echo "No branches to rebase."
  exit 0
fi

# --- Detect worktree checkouts ---

declare -A worktree_branches
while IFS= read -r wt_line; do
  # Format: /path/to/worktree  <sha> [branch] or (detached HEAD)
  wt_branch="$(echo "$wt_line" | sed -n 's/.*\[\(.*\)\].*/\1/p')"
  [[ -n "$wt_branch" ]] && worktree_branches["$wt_branch"]=1
done < <(git -C "$SCRIPT_DIR" worktree list)

# --- Fetch upstream ---

echo "=== Fetching upstream ==="
git -C "$SCRIPT_DIR" fetch upstream --quiet
UPSTREAM_DEV="$(git -C "$SCRIPT_DIR" rev-parse upstream/dev)"
echo "    upstream/dev is at ${UPSTREAM_DEV:0:12}"

# --- Create temp worktree ---

TEMP_WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/rebase-work.XXXXXX")"
rm -rf "$TEMP_WORKTREE"  # git worktree add needs a non-existent path
git -C "$SCRIPT_DIR" worktree add --detach "$TEMP_WORKTREE" upstream/dev --quiet 2>&1
echo "    temp worktree at $TEMP_WORKTREE"
echo ""

# --- Rebase loop ---

rebased=0
skipped=0
failed=0

for branch in "${branches[@]}"; do
  # Ensure local branch exists (create from origin if needed)
  if ! git -C "$SCRIPT_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
    if git -C "$SCRIPT_DIR" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      echo "--- $branch: creating local branch from origin/$branch ---"
      git -C "$SCRIPT_DIR" branch "$branch" "origin/$branch" --quiet
    else
      echo "--- $branch: SKIP (not found locally or on origin) ---"
      ((skipped++))
      continue
    fi
  fi

  # Skip if checked out in another worktree
  if [[ -n "${worktree_branches[$branch]:-}" ]]; then
    echo "--- $branch: SKIP (checked out in a worktree) ---"
    ((skipped++))
    continue
  fi

  # Check if already based on upstream/dev
  merge_base="$(git -C "$SCRIPT_DIR" merge-base "$branch" upstream/dev)"
  if [[ "$merge_base" == "$UPSTREAM_DEV" ]]; then
    echo "--- $branch: SKIP (already on upstream/dev) ---"
    ((skipped++))
    continue
  fi

  if $DRY_RUN; then
    echo "--- $branch: WOULD REBASE (merge-base ${merge_base:0:12} != upstream/dev) ---"
    continue
  fi

  echo "--- $branch: rebasing onto upstream/dev ---"
  git -C "$TEMP_WORKTREE" checkout "$branch" --quiet 2>&1

  if git -C "$TEMP_WORKTREE" rebase upstream/dev --quiet 2>&1; then
    echo "    OK"
    ((rebased++))
  else
    # Rebase failed — check if rerere resolved everything
    if git -C "$TEMP_WORKTREE" diff --quiet --diff-filter=U 2>/dev/null; then
      # All conflicts resolved by rerere
      git -C "$TEMP_WORKTREE" add -A
      if GIT_EDITOR=true git -C "$TEMP_WORKTREE" rebase --continue 2>&1; then
        echo "    OK (rerere resolved)"
        ((rebased++))
        continue
      fi
    fi

    echo ""
    echo "*** CONFLICT rebasing $branch ***"
    echo ""
    echo "Conflicting files:"
    git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U 2>/dev/null | sed 's/^/    /'
    echo ""
    echo "To resolve manually:"
    echo "    cd $TEMP_WORKTREE"
    echo "    # edit conflicting files"
    echo "    git add <resolved-files>"
    echo "    git rebase --continue"
    echo ""
    echo "After resolving, re-run this script to continue with remaining branches."
    echo "The temp worktree at $TEMP_WORKTREE was preserved for conflict resolution."
    TEMP_WORKTREE=""  # prevent cleanup from removing it
    exit 1
  fi
done

echo ""
echo "=== Summary ==="
echo "    Rebased: $rebased"
echo "    Skipped: $skipped"
if $DRY_RUN; then
  echo "    (dry run — no changes made)"
fi
echo "    Done."
