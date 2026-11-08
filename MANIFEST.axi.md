# MANIFEST.axi.md

gafgpt-cmd/omarkie-dev: Omarkie private development: all branches, unfinished work and planning. Public gafgpt-cmd/omarkie gets finished code and packages only.
Shared rules: agentic-dotfiles-linux `docs/WORKFLOW.axi.md`. Check: `repo-audit.sh --check <dir|gh:gafgpt-cmd/omarkie-dev>`.

## identity
Owner home(s) do the work. Fork details: fork.json + FORK.md.
```json
{"identity": {
  "manifest_schema": 1,
  "repo": "gafgpt-cmd/omarkie-dev",
  "visibility": "private",
  "default_branch": "main",
  "owner_homes": [],
  "is_fork": false,
  "upstream": null,
  "fork_manifest": "fork.json",
  "fork_doc": "FORK.md"
}}
```

## branches
One task, one worktree, one prefixed branch. No open PR after 3 days = flagged.
```json
{"branches": {
  "work_prefixes": ["fm-<home>/","fm/","v2/wp-","sync/"],
  "integration": null,
  "max_open_days_without_pr": 3,
  "auto_delete_on_merge": true,
  "local_default_commits": false,
  "rerere": false,
  "keep": ["release-please--*"]
}}
```

## landing
Default branch only through no-mistakes; branch-to-branch merges need the fast check only. Workflows: ci.yml release.yml.
```json
{"landing": {
  "gate": "no-mistakes",
  "gate_config": ".no-mistakes.yaml",
  "ci_workflows": [".github/workflows/ci.yml"],
  "merge_style": "squash",
  "default_branch_via": "no-mistakes",
  "branch_merges": "fast-check"
}}
```

## deploy
No installed copy known. Local clones stay clean on main and current; work happens in worktrees.
```json
{"deploy": {
  "live_checkouts": ["~/Projects/omarkie-dev","~/firstmate/projects/omarkie-dev"],
  "update": "pull-ff-only",
  "runtime_written": [],
  "build_stamp": null,
  "binary": null,
  "release": "none"
}}
```

## updates
Own code, no upstream. Telemetry stays out.
```json
{"updates": {
  "installed_via": "none",
  "upstream_sync": "n/a",
  "protected": [],
  "deployed": [],
  "telemetry": {"policy":"removed","removed":[],"scan":[],"allow":[]}
}}
```

## sync
n/a: not a fork.
```json
{"sync": {
  "cadence": "n/a",
  "owner": null,
  "max_behind_commits": null
}}
```

## hygiene
Weekly: vibe-clean, branch prune, repo-audit.sh --check, dark-feature review.
```json
{"hygiene": {
  "cadence": "weekly",
  "forbidden_tracked": ["*.log","scratchpad*",".no-mistakes/**"],
  "dark_features": []
}}
```

## traps
Ways this repo broke before.
```json
{
  "traps": []
}
```
