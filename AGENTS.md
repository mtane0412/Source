# AGENTS.md

## Scope

This repository is the default Ghost theme. Keep changes focused on theme source, generated assets, CI, and repo-level metadata for this repository.

## Commands

Use pnpm for this repo.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test:ci
pnpm zip
```

Run the test command before opening a PR when theme files, generated assets, dependencies, or CI change.

## Upstream sync

This repository was originally forked from [TryGhost/Source](https://github.com/TryGhost/Source) and is customized for personal use, but the GitHub fork relationship has been intentionally detached (Settings > Danger Zone > "Leave fork network"). `gh repo view` reports `isFork: false` / `parent: null`. This is a deliberate safety measure: while forked, `gh pr create` without an explicit `--repo` silently resolved the base repository to TryGhost/Source and opened an unintended PR against it. With no parent relationship, neither `gh` nor GitHub's web UI has an upstream to default to.

The `.github/workflows/sync-upstream.yml` workflow checks upstream weekly (and on manual dispatch): if TryGhost/Source's `main` has new commits, it merges them into a `sync/upstream-*` branch, runs `pnpm test:ci` against the merged result, and opens a PR against `main` with the test outcome noted in the description. If the merge conflicts, it opens an issue instead of a PR.

**Safety: this repo must never open a PR against TryGhost/Source.** The detached fork relationship is the primary guarantee, but the workflow keeps two defense-in-depth safeguards in case the repo is ever re-forked or this workflow is copied elsewhere:
- Every `gh pr create` / `gh issue create` call passes `--repo "$GH_REPO"` (`GH_REPO` is pinned to `${{ github.repository }}`), and a guard step aborts the job if `GH_REPO` is `TryGhost/Source`.
- TryGhost/Source is never registered as a git remote (no `upstream` remote). Fetches use the URL directly (`git fetch https://github.com/TryGhost/Source.git main`, then merge `FETCH_HEAD`), so there is no persistent remote name that a `git push` could accidentally target.

Keep both safeguards intact when editing the workflow or these instructions. Do not re-add `git remote add upstream ...` for convenience, and do not re-fork/re-attach this repo to TryGhost/Source.

The repository's "Workflow permissions" setting (Settings > Actions > General) must allow read/write for `GITHUB_TOKEN`, or the workflow cannot push branches or create PRs/issues.

To sync manually:

```bash
git fetch https://github.com/TryGhost/Source.git main
git checkout -b sync/upstream-manual
git merge FETCH_HEAD
# resolve conflicts, then commit and push
```

When creating a PR by hand, always pass `--repo mtane0412/Source` (or `-R`) explicitly to `gh pr create` / `gh issue create` — never rely on the default.

## Boundaries

- Edit source CSS, JavaScript, Handlebars templates, partials, and package metadata intentionally.
- Keep generated assets/built/ files in sync when source assets change and the repo tracks those outputs.
- Do not commit node_modules/, local Ghost content, generated zip files outside tracked release expectations, or secrets.
- Repo settings, descriptions, and branch rules belong on the GitHub repository; internal clean-repos metadata stays in TryGhost/cleanrepos.
