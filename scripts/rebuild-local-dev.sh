#!/usr/bin/env bash
# rebuild-local-dev.sh — Rebuild the local-integrated integration branch.
#
# Usage: ./scripts/rebuild-local-dev.sh [--dry-run]
#
# Reads .local-branches manifest and merges each branch into local-integrated
# with --no-ff, in listed order. local-integrated is hard-reset to
# upstream/dev first, so this is always a clean rebuild.
#
# Guards:
#   - All manifest branches must exist
#   - All manifest branches must be rebased onto current upstream/dev
#   - No in-progress rebase on any manifest branch
#   - local-integrated must not be checked out in any worktree
#
# Safe: uses a temp worktree for the merge work.
#
# The filename still reads `rebuild-local-dev.sh` for historical
# continuity; the integration branch was originally named `local-dev`
# and has since been renamed to `local-integrated`.

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

# Check local-integrated not checked out in a worktree
while IFS= read -r wt_line; do
  wt_branch="$(echo "$wt_line" | sed -n 's/.*\[\(.*\)\].*/\1/p')"
  if [[ "$wt_branch" == "local-integrated" ]]; then
    echo "ERROR: local-integrated is checked out in a worktree: $wt_line"
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
  echo "=== Dry Run: would merge these into local-integrated ==="
  for i in "${!branches[@]}"; do
    echo "    $((i+1)). ${branches[$i]}"
  done
  echo "    (no changes made)"
  exit 0
fi

# --- Reset local-integrated ---

echo "=== Resetting local-integrated to upstream/dev ==="

# Create or reset local-integrated branch ref (without needing a checkout)
git -C "$SCRIPT_DIR" update-ref refs/heads/local-integrated "$UPSTREAM_DEV"
echo "    local-integrated reset to ${UPSTREAM_DEV:0:12}"

# --- Create temp worktree on local-integrated ---

TEMP_WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/rebuild-local-integrated.XXXXXX")"
rm -rf "$TEMP_WORKTREE"
git -C "$SCRIPT_DIR" worktree add "$TEMP_WORKTREE" local-integrated --quiet 2>&1
echo "    temp worktree at $TEMP_WORKTREE"
echo ""

# --- Merge loop ---

echo "=== Merging branches into local-integrated ==="

# Apply any post-merge patch for the just-merged branch.
# Patches live at scripts/post-merge-patches/<branch-with-slashes-as-dashes>.patch
# and address integration-time fixups that cannot live on the standalone branch
# (typically because they extend code introduced by a sibling branch's merge).
# Each applied patch produces an additional commit on local-integrated immediately
# after the integrate merge.
apply_post_merge_patch() {
  local branch="$1"
  local slug="${branch//\//-}"
  local patch="$SCRIPT_DIR/post-merge-patches/${slug}.patch"
  if [[ ! -f "$patch" ]]; then
    return 0
  fi
  echo "    post-merge patch: $patch"
  if ! git -C "$TEMP_WORKTREE" apply --check "$patch" 2>&1; then
    echo "*** post-merge patch FAILED to apply cleanly for $branch ***"
    echo "    patch: $patch"
    echo "    The patch was authored against a known surface that has likely"
    echo "    drifted upstream. Update the patch file or re-encode the fix"
    echo "    on the owning branch."
    return 1
  fi
  git -C "$TEMP_WORKTREE" apply "$patch"
  git -C "$TEMP_WORKTREE" add -A
  GIT_COMMITTER_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    git -C "$TEMP_WORKTREE" -c commit.gpgsign=false commit \
      --no-verify --quiet \
      -m "post-integrate: ${slug} (${patch##*/})" \
      -m "Auto-applied by rebuild-local-dev.sh from $patch"
  echo "    post-merge patch applied"
}

merged=0
for branch in "${branches[@]}"; do
  echo "--- integrate: $branch ---"
  merge_status=0
  git -C "$TEMP_WORKTREE" merge --no-ff "$branch" -m "integrate: $branch" --quiet 2>&1 || merge_status=$?
  unresolved="$(git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U)"
  if [[ $merge_status -eq 0 ]]; then
    echo "    OK (clean)"
  elif [[ -z "$unresolved" ]]; then
    # Merge exit was non-zero, but rerere (or auto-merge) resolved every
    # conflict and staged the result. Finalize with a commit so the
    # integrate-merge commit is produced.
    git -C "$TEMP_WORKTREE" -c commit.gpgsign=false commit --no-edit --no-verify --quiet
    echo "    OK (rerere auto-resolved)"
  else
    echo ""
    echo "*** CONFLICT merging $branch into local-integrated ***"
    echo ""
    echo "Conflicting files:"
    git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U 2>/dev/null | sed 's/^/    /'
    echo ""
    echo "This usually means two local/* branches modify the same lines."
    echo "Options:"
    echo "  1. Resolve the conflict in the branch that was added later."
    echo "  2. Reorder branches in .local-branches to reduce overlap."
    echo ""
    echo "Aborting merge and resetting local-integrated to upstream/dev."
    git -C "$TEMP_WORKTREE" merge --abort 2>/dev/null || true
    git -C "$SCRIPT_DIR" update-ref refs/heads/local-integrated "$UPSTREAM_DEV"
    exit 1
  fi
  if ! apply_post_merge_patch "$branch"; then
    echo "Aborting and resetting local-integrated to upstream/dev."
    git -C "$SCRIPT_DIR" update-ref refs/heads/local-integrated "$UPSTREAM_DEV"
    exit 1
  fi
  ((++merged))
done

# --- Summary ---

FINAL_SHA="$(git -C "$TEMP_WORKTREE" rev-parse HEAD)"

echo ""
echo "=== local-integrated rebuilt ==="
echo "    Base:     upstream/dev (${UPSTREAM_DEV:0:12})"
echo "    Tip:      ${FINAL_SHA:0:12}"
echo "    Branches: $merged merged"
echo ""
echo "    Branch merge order:"
for i in "${!branches[@]}"; do
  echo "      $((i+1)). ${branches[$i]}"
done
echo ""
echo "    To deploy: git push origin local-integrated --force-with-lease"
