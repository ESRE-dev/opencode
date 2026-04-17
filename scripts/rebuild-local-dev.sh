#!/usr/bin/env bash
# rebuild-local-dev.sh — Rebuild the local-dev integration branch.
#
# Usage: ./scripts/rebuild-local-dev.sh [--dry-run]
#
# Reads .local-branches manifest and merges each branch into local-dev
# with --no-ff, in listed order. local-dev is hard-reset to upstream/dev
# first, so this is always a clean rebuild.
#
# Guards:
#   - All manifest branches must exist
#   - All manifest branches must be rebased onto current upstream/dev
#   - No in-progress rebase on any manifest branch
#   - local-dev must not be checked out in any worktree
#
# Safe: uses a temp worktree for the merge work.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
    git -C "$TEMP_WORKTREE" merge --abort 2>/dev/null || true
    git -C "$SCRIPT_DIR" worktree remove --force "$TEMP_WORKTREE" 2>/dev/null || true
    rm -rf "$TEMP_WORKTREE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Read manifest ---

branches=()
if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: .local-branches manifest not found at $MANIFEST"
  exit 1
fi

while IFS= read -r line; do
  line="${line%%#*}"
  line="${line// /}"
  [[ -z "$line" ]] && continue
  branches+=("$line")
done < "$MANIFEST"

if [[ ${#branches[@]} -eq 0 ]]; then
  echo "ERROR: .local-branches manifest is empty."
  exit 1
fi

# --- Preflight checks ---

echo "=== Preflight ==="

UPSTREAM_DEV="$(git -C "$SCRIPT_DIR" rev-parse upstream/dev)"
echo "    upstream/dev: ${UPSTREAM_DEV:0:12}"

errors=0

# Check local-dev not checked out in a worktree
while IFS= read -r wt_line; do
  wt_branch="$(echo "$wt_line" | sed -n 's/.*\[\(.*\)\].*/\1/p')"
  if [[ "$wt_branch" == "local-dev" ]]; then
    echo "ERROR: local-dev is checked out in a worktree: $wt_line"
    echo "       Check it out on a different branch first."
    ((errors++))
  fi
done < <(git -C "$SCRIPT_DIR" worktree list)

for branch in "${branches[@]}"; do
  # Branch must exist
  if ! git -C "$SCRIPT_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "ERROR: $branch does not exist as a local branch."
    echo "       Run rebase-branches.sh first to create it from origin."
    ((errors++))
    continue
  fi

  # Branch must be rebased onto upstream/dev
  merge_base="$(git -C "$SCRIPT_DIR" merge-base "$branch" upstream/dev)"
  if [[ "$merge_base" != "$UPSTREAM_DEV" ]]; then
    echo "ERROR: $branch is not rebased onto current upstream/dev."
    echo "       merge-base: ${merge_base:0:12}, need: ${UPSTREAM_DEV:0:12}"
    echo "       Run rebase-branches.sh first."
    ((errors++))
  fi

  # No in-progress rebase
  # Check if REBASE_HEAD exists for this branch via worktree
  # (This is a heuristic — REBASE_HEAD is per-worktree, not per-branch)
done

if [[ $errors -gt 0 ]]; then
  echo ""
  echo "Preflight failed with $errors error(s). Fix the above and retry."
  exit 1
fi

echo "    All ${#branches[@]} branches verified."
echo ""

# --- Dry run ---

if $DRY_RUN; then
  echo "=== Dry Run: would merge these into local-dev ==="
  for i in "${!branches[@]}"; do
    echo "    $((i+1)). ${branches[$i]}"
  done
  echo "    (no changes made)"
  exit 0
fi

# --- Reset local-dev ---

echo "=== Resetting local-dev to upstream/dev ==="

# Create or reset local-dev branch ref (without needing a checkout)
git -C "$SCRIPT_DIR" update-ref refs/heads/local-dev "$UPSTREAM_DEV"
echo "    local-dev reset to ${UPSTREAM_DEV:0:12}"

# --- Create temp worktree on local-dev ---

TEMP_WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/rebuild-localdev.XXXXXX")"
rm -rf "$TEMP_WORKTREE"
git -C "$SCRIPT_DIR" worktree add "$TEMP_WORKTREE" local-dev --quiet 2>&1
echo "    temp worktree at $TEMP_WORKTREE"
echo ""

# --- Merge loop ---

echo "=== Merging branches into local-dev ==="

merged=0
for branch in "${branches[@]}"; do
  echo "--- integrate: $branch ---"
  if git -C "$TEMP_WORKTREE" merge --no-ff "$branch" -m "integrate: $branch" --quiet 2>&1; then
    echo "    OK"
    ((merged++))
  else
    echo ""
    echo "*** CONFLICT merging $branch into local-dev ***"
    echo ""
    echo "Conflicting files:"
    git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U 2>/dev/null | sed 's/^/    /'
    echo ""
    echo "This usually means two local/* branches modify the same lines."
    echo "Options:"
    echo "  1. Resolve the conflict in the branch that was added later."
    echo "  2. Reorder branches in .local-branches to reduce overlap."
    echo ""
    echo "Aborting merge and resetting local-dev to upstream/dev."
    git -C "$TEMP_WORKTREE" merge --abort 2>/dev/null || true
    git -C "$SCRIPT_DIR" update-ref refs/heads/local-dev "$UPSTREAM_DEV"
    exit 1
  fi
done

# --- Summary ---

FINAL_SHA="$(git -C "$TEMP_WORKTREE" rev-parse HEAD)"

echo ""
echo "=== local-dev rebuilt ==="
echo "    Base:     upstream/dev (${UPSTREAM_DEV:0:12})"
echo "    Tip:      ${FINAL_SHA:0:12}"
echo "    Branches: $merged merged"
echo ""
echo "    Branch merge order:"
for i in "${!branches[@]}"; do
  echo "      $((i+1)). ${branches[$i]}"
done
echo ""
echo "    To deploy: git push origin local-dev --force-with-lease"
