# Glass swap

Select a page element, press **Change**, say or type what bothers you.
Chips filter by kind: a picture offers Enhance, Find better, Generate; prose offers Rewrite; a Mermaid fence offers Redraw.
Every candidate shows its source and licence before you can use it.

## Destinations

| Button | What it writes | Undo |
| --- | --- | --- |
| **Cover on my glass** (default) | One glass magnet over the element. The note file stays byte-identical. | Deletes the magnet |
| **Replace in page** (labelled, secondary) | The element's bytes, a vault picture and one attribution footnote. Preview + Accept first. | Restores the undo copy |

- Cover first: the risky path must not be the default.
- Replace previews the old and new lines plus the footnote; `Accept` writes.
- A stale preview never writes: the note hash must still match.
- Undo is a journal op, not a toast timer.

## Candidates

- Original always first, labelled `Current`; up to three more.
- Compare reuses the G15 slider (one widget).
- Vault pictures are searched first; no index needed.
- Online search is opt-in twice: the person clicks, and the vault allows it.
  - Wikimedia Commons + Openverse, licence allow-list CC0 / BY / BY-SA.
  - Results need title, author, licence and landing URL; NC/ND are refused with the reason.
  - `OMARKIE_SWAP_SEARCH` points at a JSON results file for offline machines and tests.
- Enhance and Generate exist only when `OMARKIE_ENHANCE` / `OMARKIE_IMAGEGEN` are configured.
- Rewrite and Redraw use the Tutor bridge (`check` verb, JSON reply with `replacement`).
  - Redraw renders through Mermaid `securityLevel: strict`.

## Attribution

```
"Title" by Creator, BY 3.0, via Wikimedia Commons — <landing URL> (resized; accessed YYYY-MM-DD)
```

- Vault: `"name" from your vault — path (accessed date)`.
- Local hook: `"name" made on this machine (accessed date)`.
- Tutor: `"name" the tutor (accessed date)`.
- Online candidates cannot apply without licence data.

## Agents

```sh
omarkie-axi element swap --note review.md --element paragraph-3 \
  --complaint "too dense" --kind find --online
omarkie-axi element cover --note review.md --element image-2 --candidate '<json>' --accept
omarkie-axi element swap --note review.md --element image-2 --candidate '<json>' --mode replace --accept
omarkie-axi element restore --note review.md --element image-2 --accept
```

- Proposals: `element swap --candidates '<json>' --accept` writes waiting cards.
- Caps: 8 per batch, 20 open per note, 12 per hour.
- Nothing applies without Accept.

## Settings

- `neverOnline` lives in the glass settings, per vault.
- Voice complaints use `OMARKIE_STT`; no audio leaves the machine.
