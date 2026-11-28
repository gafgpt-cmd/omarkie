# Glass cards

Short links in the margin. Click a pill, the card opens beside it. Click again, it folds.
The page text never moves: cards live on the `ai-cards` glass layer, not in the Markdown.

## Kinds

| Kind | Holds | Opens as page |
| --- | --- | --- |
| `static` | A section from another note (`[[Note#Section]]`); resolves on demand, follows edits | The section text |
| `ai` | One question and its cached Tutor answer; cue style | Question + answer |
| `menu` | A list of `{label, body}` choices; quizzes reveal one answer | One section per choice |
| `fold` | A Fold view line (`question`), its Full author words (`answer`), its stop and `[[Note#Heading]]` | The line + quoted evidence + source |

- Only one card unfolds at a time. A popup must not bury its neighbours.
- Folded cards mount only the pill; the body's state and link resolution start on unfold.
- A static card polls while unfolded; a missing note or section states why.
- AI answers stay in the journal. Offline, the cached answer still renders. Regenerate asks again.
- Identifiers in a question or its paragraph block the ask until each one is marked not identifying.
- A `fold` card comes from dragging a fold line onto the page (Glass on), or D → Card on the page. It never merges into the note: its evidence is already there.

## Open as page

The button writes a new Markdown note beside the source note. The source note is never edited.
An existing page is never overwritten; a second write gets `(2)` in the name.

## Commands

```sh
omarkie-axi glass add --note review.md --kind card --card static \
  --link '[[Reference#Kerma]]' --near "Kerma is the kinetic energy" --title "Kerma"
omarkie-axi glass add --note review.md --kind card --card ai \
  --question "Why does mass matter?" --near "Kerma is the kinetic energy"
omarkie-axi glass add --note review.md --kind card --card menu \
  --choices '[{"label":"What is kerma?","body":"Energy per unit mass."}]' --near "Kerma is"
omarkie-axi glass edit --note review.md --magnet <id> --unfold
omarkie-axi glass edit --note review.md --magnet <id> --folded
omarkie-axi glass page --note review.md --magnet <id>
omarkie-axi glass list --note review.md
```

Cards are folded when added by an agent. `--unfold` opens one in the app.

## Code

- `shared/glass-cards.mjs`: link parsing, section extraction, choices, page Markdown. Pure.
- `src/glass/card-model.ts`: journal magnet to card, pill placement.
- `src/components/GlassCard.tsx`: pill, panel, AI ask, dialog.
- `electron/glass-service.mjs`: `card` request (resolve/page), journal fields.

## Proof

```sh
node --import ./tests/setup-language.mjs --test tests/glass-cards.test.mjs
node tests/glass-cards-desktop.mjs
```

Desktop proof creates all three kinds, folds and unfolds by mouse and keyboard, edits the source
section under a static card, asks and regenerates with a stub agent, reveals menu answers, writes a
page and compares vault checksums, restarts, and measures the glass open with 200 pills against the
plain open (best of three) plus one unfold's main-thread work and frames under trusted input.
