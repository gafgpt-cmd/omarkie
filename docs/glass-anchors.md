# Glass landmark anchors

A magnet remembers where it sits without touching the page.
Six landmarks, strongest first. On open the first that still matches wins; the rest cross-check.

| # | Landmark | Kind | Survives |
| --- | --- | --- | --- |
| 1 | element fingerprint: block kind + text hash, images: file hash + name | `fingerprint` | nothing changed |
| 2 | quote: exact words + 32 chars before/after (W3C TextQuote) | `quote` | edits elsewhere, paragraph moved |
| 3 | heading path | `heading` | section reorder |
| 4 | neighbour fingerprints | `neighbours` | its own paragraph rewritten |
| 5 | line, char offset, word index, % through note | `position` | heavy rewrite inside the same section |
| 6 | spot inside the box: x/y % + px fallback | `spot` | resize, other width, phone vs desktop |

Journal field `anchor`, additive and versioned:

```json
{"version":2,"landmarks":[
  {"kind":"fingerprint","value":{"tag":"paragraph","hash":"9f9920e6a9eb837c"}},
  {"kind":"quote","value":{"exact":"Space the reviews over days.","prefix":"# Memory\n\n","suffix":"\n"}},
  {"kind":"heading","value":{"path":["Memory"]}},
  {"kind":"neighbours","value":{"before":"…","after":"…"}},
  {"kind":"position","value":{"line":5,"char":28,"word":4,"percent":0.17}},
  {"kind":"spot","value":{"x":0.5,"y":0.5,"px":0,"py":0}}
]}
```

Version 1 (`{"kind":"block", block, headings, line}`) still reads. Unknown ops stay untouched.

## Confidence

| Confidence | State | UI |
| --- | --- | --- |
| ≥ 0.8 | placed | solid badge |
| 0.5–0.8 | check | dotted badge + "check me" |
| < 0.5 | tray | "Check placement" list, old context, one click |

A tie never guesses: two identical paragraphs in the same section go to the tray.
A badge sits below its paragraph without covering its text. Multiple magnets on one paragraph wrap. The tray stays above the status bar.

## Matching

- Exact fingerprint or quote wins.
- Quote fuzzy match is an in-repo 3-gram window score, Bitap-sized. No dependency, no telemetry; `tests/glass-anchor.test.mjs` pins the scores. 0.45 floor, 0.08 margin over the runner-up.
- Position is ignored when its heading path vanished, so a deleted paragraph lands in the tray instead of the nearest survivor.
- A new edition resolves all anchors in one bulk pass: 0.8 and up is placed, 0.5–0.8 opens the check-placement tray with the old and new context, and below 0.5 or a deleted paragraph shows in the orphan tray. Place, keep, or unanchor; the note is never rewritten.
- In-app edits map every landmark char offset through `ChangeSet.mapPos`; the mapped block is exact (confidence 0.95). Landmarks are re-captured when the note saves.

## Code

- `src/glass/anchor-map.ts`: capture, resolve, place, confidence.
- `src/glass/glass-state.ts`: strict reader for stored anchors.
- `src/components/GlassLayer.tsx`: magnets from the journal, tray, re-anchor click.
- `shared/glass-core.mjs` + `electron/glass-service.mjs`: `anchor` field validation.
- `electron/tutor-cli.mjs`: `omarkie-axi glass add … --anchor '<json>'`.

## Proof

```sh
node --import ./tests/setup-language.mjs --test tests/glass-anchor.test.mjs
node tests/glass-landmarks-desktop.mjs
```

Desktop proof: five debug magnets, then edit the note outside Omarkie (insert above, move paragraph, rewrite paragraph, reorder sections, delete one paragraph).
Each lands solid, dotted, or in the tray. None lost. Screenshots at 1440/720 in light and dark.
