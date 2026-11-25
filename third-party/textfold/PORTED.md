# TextFold

- Source: https://github.com/chenxiachan/textfold
- Commit: `7dedb2d678df575b620c9b7c07a41d21520eab94` (v0.10.57)
- Author: Xia Chen
- License: Apache-2.0, see `LICENSE`. Upstream attribution: `NOTICE` (parts that apply to the ported code).
- No upstream code that phones home, updates itself or loads remote assets is ported.

## Files adapted in Omarkie

| Omarkie file | Upstream | Changed |
|---|---|---|
| `shared/fold-format.mjs`, `shared/fold-format.d.mts` | `textfold/ladder.py`, `docs/format.md` | six stops with Estudio, slider order, clinical roles, per-line evidence with element ids and offsets, check results, slot and route per record |
