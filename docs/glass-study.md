# Glass study

Pin names on a picture, hide them, review what you missed. One card framework: labels, menu cards and marked bubbles all feed the same FSRS-6 queue.

## Labels

Picture tool → **Label** → click the picture. The pin keeps a fraction of the image box, so resizing or wrapping never shears it.
Type the name, Enter saves. Double-click renames. Drag moves the text; the leader line follows.

| Control | Does |
| --- | --- |
| **Hide labels** | Every name folds to a pin with `?`; click a pin to reveal that answer |
| ✓ / ✗ after reveal | Right keeps the schedule; wrong creates a due card immediately |
| ★ | Marks the label for exam mode |

## Spaced repetition

- One `study.jsonl` per vault, append-only, beside the glass journal.
- FSRS-6 through `ts-fsrs`; parameters are explicit (`enable_fuzz: false`) so tests are stable.
- A miss creates the card due now; the first review is the first real grade, never recorded twice.
- Review sheet: **Review N due** in the rail. Space reveals, `1`-`4` grade (again, hard, good, easy), `←`/`→` move, Esc closes.
- Due counts refresh when the rail gains focus, every minute, and after a label miss.

## Exam mode

**Exam mode** folds every bubble, card and label on the note to a cue. The panel walks cues one by one:
Space reveals, arrows move, `1`-`4` preview the next interval.
Preview grades write nothing, so a mock exam never moves a due date. **Quiz only what I marked** filters to ★ items.

## Commands

```sh
omarkie-axi glass label add --note review.md --image <magnet> --text "Median nerve" --x 0.55 --y 0.45
omarkie-axi glass label hide --note review.md --magnet <label>
omarkie-axi glass label reveal --note review.md
omarkie-axi srs due --vault .
omarkie-axi srs review --card <id> --grade good
omarkie-axi exam on --note review.md
omarkie-axi exam off --note review.md
```

`--preview` on `srs review` returns the next interval without writing a review.

## Code

- `shared/glass-labels.mjs`: target and pin validation, normalized point, text box. Pure.
- `shared/srs-core.mjs`: journal parse, FSRS replay, due queue, exam filter. Pure.
- `src/components/GlassLabel.tsx`: pin, leader, hidden quiz, edit and drag.
- `src/components/SrsPanel.tsx`, `StudyQueue.tsx`: due count and keyboard review.
- `src/components/ExamPanel.tsx`: cue walk and preview grades.
- `electron/glass-service.mjs`: label fields, `study.jsonl`, `srs-*`, `study-*`.

## Proof

```sh
node --test tests/glass-labels.test.mjs tests/srs-core.test.mjs
node tests/glass-study-desktop.mjs
```

Desktop proof pins a label on a dropped picture, hides and reveals it, misses it into a due card,
reviews with Space and `3`, marks it, folds the note to a cue in exam mode without moving due dates,
checks label hide/reveal and exam on/off through the CLI, and restarts to prove state persists.
