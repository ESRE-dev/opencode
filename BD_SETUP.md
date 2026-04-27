# Beads (bd) Setup for the Fork

`bd` (beads) is the issue tracker we use across this fork. It stores
issues in a local Dolt database under `.beads/`. This doc covers the
fork-specific setup — the policy decisions that aren't part of bd's
defaults.

## Backup policy: Dolt → S3 only, never git

By default, `bd` auto-enables a periodic JSONL backup whenever the repo
has a git remote. The backup writes `.beads/backup/*.jsonl` and runs
`git add` / `git commit` / `git push` on a hidden hook. In this fork
that produced **61 unsolicited `bd: backup` commits** on whatever
branch happened to be checked out, until we disabled it.

We disable that in two places:

### 1. `.beads/config.yaml` (per-clone, controls `bd` itself)

```yaml
backup:
  enabled: false
  git-push: false

dolt.auto-push: true
dolt.port: 3310   # opencode-specific — vsgoat uses 3308
```

`dolt.auto-push: true` makes Dolt the **only** sanctioned backup channel.
Dolt pushes to AWS S3 via the gastown rig daemon (`gt dolt`); see the
`gastown-rig-management` skill if you're setting up a new rig.

### 2. `.gitignore` (committed, controls git itself)

```
# .beads/ — bd state lives only locally; backup goes to S3 via Dolt
.beads/
```

This is the durable belt-and-suspenders: even if someone re-runs
`bd init` in a fresh clone and the bd config defaults flip auto-backup
back on, `git` will refuse to track anything under `.beads/`.

The reference repos (`~/Code/vsgoat`, `~/Code/pf-cpharm-hub`) commit
their `.beads/config.yaml` and a one-shot JSONL seed. We chose **not**
to do that here — `.beads/` stays per-clone, and a fresh clone bootstraps
its own bd state via `bd init` followed by manually setting the three
config keys above.

## Bootstrapping a fresh clone

```bash
git clone git@github.com:ESRE-dev/opencode.git
cd opencode

# Initialize bd locally (creates .beads/, ignored by git via .gitignore)
bd init

# Apply the no-git-backup overrides
cat >> .beads/config.yaml <<'EOF'

# Disable JSONL git backup — Dolt S3 push is the sole backup channel
backup:
  enabled: false
  git-push: false

dolt.auto-push: true
dolt.port: 3310
EOF
```

If you want the rig to auto-push Dolt to S3, follow the
`gastown-rig-management` skill to register this clone and assign a polecat.

## Why no `.beads/` in git?

- The Dolt database is large and binary; committing it bloats the repo.
- The JSONL backup is a recovery snapshot, not a source of truth — its
  source of truth is Dolt, and Dolt has its own remote (S3).
- Auto-commit hooks were running on every `bd` mutation, which produced
  cross-branch noise (commits landed on whatever branch was checked out
  when `bd` ran). Stripping `.beads/` out of git makes that physically
  impossible.

## What lives where

| Path                       | Tracked? | Notes                                              |
| -------------------------- | -------- | -------------------------------------------------- |
| `.beads/`                  | No       | Excluded via fork's `.gitignore`                   |
| `.beads/config.yaml`       | No       | Per-clone; copy the snippet above when bootstrapping |
| `.beads/dolt/`             | No       | Local Dolt database, replicates to S3              |
| `.beads/backup/*.jsonl`    | No       | Old auto-export target — disabled, do not re-enable |
| `.beads/hooks/`            | No       | bd's git hooks (managed by `bd init`)              |

## Recovery: if `bd: backup` commits reappear

1. Check `.beads/config.yaml` — `backup.enabled` and `backup.git-push`
   must both be `false`. If they aren't, someone re-ran `bd init`
   without applying the overrides.
2. Check `git log --grep='^bd: backup'` — if commits exist on a `local/*`
   or integration branch, file an issue and rebase them out (they only
   touch `.beads/backup/*.jsonl`, so dropping is safe).
3. Verify the fork's root `.gitignore` still has `.beads/`.

## See also

- `~/Code/vsgoat/.beads/config.yaml` — the original repo where this
  problem was first hit (164 unsolicited commits before the fix).
- gastown skill for `gt dolt` (Dolt → S3 backup automation).
