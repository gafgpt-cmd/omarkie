# markdown-it

- Source: https://github.com/markdown-it/markdown-it
- Package: `markdown-it@15.0.3` (already a pinned dependency)
- License: MIT, see `LICENSE`.
- Local rule only; no network, telemetry or update code involved.

## Files adapted in Omarkie

| Omarkie file | Upstream | Changed |
|---|---|---|
| `src/editor/smartPunctuation.ts` | `src/rules_core/smartquotes.ts` | quote pairing over generic segments (tokens or reading DOM); locale pairs `en`/`es`/`ca`; marks after a digit or backslash stay straight; own dash and ellipsis rules (no `replacements`: `10--20`, `--flag`, `(c)` stay literal) |
