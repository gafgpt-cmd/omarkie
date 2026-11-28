# Document workflows

- File → Document tools: OKF, templates, citations, upkeep.
- File → Properties: preview one YAML property, then apply to draft.
- Ctrl/Cmd-click wiki links and tags in rich mode.
- Ambiguous targets list every candidate. Missing targets never create files.
- Heading fragments open their target line.
- Open a folder before vault search, linked mentions or graph.
- Graph loads only when opened. First 200 notes; reports use the bounded inventory below.

## Section embeds

| Syntax | Shows |
| --- | --- |
| `![[Note]]` | whole note, no frontmatter |
| `![[Note#Heading]]` | heading + its section, to next heading of same or higher level |
| `![[#Heading]]` | section of this note |
| `![[Note#Parent#Heading]]` | nested heading path |
| `![[Note#Heading-1]]` | 2nd duplicate heading (`-1`, `-2`: same ids as heading links) |
| `![[Note#^block-id]]` | not supported yet: visible notice |

- Read-only preview in rich mode and reading layer. Source stays the line you wrote.
- Click the title, or Ctrl/Cmd+Enter on the line: opens the source note at the heading. Arrow keys stop on embed lines.
- Headings in fences and frontmatter never match. Exact heading text wins over slug match.
- Paths and images inside the section resolve from the embedded note's folder.
- Unsaved drafts win over disk. Every open note embedding a changed note refreshes, no save needed.
- Visible states: missing note, several notes (write the folder), missing heading, duplicate heading, self/cycle, too deep (4 levels), too long (512 KiB total).
- Vault notes only. No remote loads. Local reads: 64 notes per batch, 8 MiB per note, inside the vault.
- HTML/PDF export: section text frozen in, title links to the source note.
- Saved Markdown keeps `![[...]]`. Vault bundle: embed becomes a link to its note; an unresolved embed stops the export at `note:line`.

## Bases

Obsidian `.base` files: read-only table or cards of vault notes.

- Open from the file list or Quick Open. View tabs on top.
- Keyboard: Left/Right/Home/End switch views; Tab into rows or cards; Up/Down/Left/Right/Home/End move; Enter or Space opens the note.
- Embed in a note: `![[file.base]]` (first view) or `![[file.base#View]]`.
  - Read-only, live, click a row or card to open its note.
  - Ctrl/Cmd+Enter on the embed line opens the full base.
  - Unknown view: notice, first view shown. Missing or ambiguous file: notice.
  - HTML export keeps the rows as drawn.
- Live: drafts, external edits, renames and deletes update rows. No reindex, no save needed.
- Never writes the `.base` file. No network. No JS, DataviewJS, remote data or executable formulas.

| Part | Supported |
| --- | --- |
| `filters` (global + per view) | `and` / `or` / `not`, comparisons, `&&` `\|\|` `!`, `+ -` dates and durations (`"1 week"`, `"3M"`) |
| Functions | `file.hasTag`, `file.inFolder`, `file.hasProperty`, `date()`, `now()`, `today()`, `number()`, `list()`, `if()` |
| Methods | `contains`, `containsAll`, `containsAny`, `startsWith`, `endsWith`, `lower`, `upper`, `trim`, `isEmpty`, `isTruthy`, `toString`, `.length` |
| Columns (`order`) | `file.name/basename/path/folder/ext/size/ctime/mtime/tags`, note properties (`author`, `note.author`, `note["x y"]`) |
| `properties.*.displayName` | column titles |
| `sort`, `limit` | yes; empties last, then path order |
| View types | `table`, `cards` (title + property list); others shown as a table |

Not supported, with a visible notice: `formulas`, `summaries`, `groupBy`, unknown keys, unknown functions or fields (e.g. `file.backlinks`).

- Unsupported filter part: not applied, never hides rows. View flagged "may list extra notes".
- `limit` cut: count shows "Showing N of M".
- Bounds: 256 KiB `.base`, 4096-char expression, depth 48, 500 filter conditions, 64 views, 1000 rows drawn.
- Notes that fail to read are counted, not guessed.

## Reading summary

- File → Collect highlights and callouts.
- Collects `==highlights==` and `> [!type]` callouts from the current draft, in source order.
- Opens a separate Markdown draft. Save it wherever you want.
- No matches: no draft. The source note stays unchanged.
- Parser: existing markdown-it (MIT). [Quartz](https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts) (MIT) reviewed; no code copied.

## Source safety

- Opening/saving existing notes never adds metadata.
- New notes declare generic `Reference`; no inferred domain type.
- Properties edit YAML node ranges, not a whole-document serializer.
- Unknown YAML fields/comments and body text remain unchanged.
- Cyclic YAML aliases stay intact; their value is source-edit-only in Properties.
- Note/folder make-ready previews each proposed change; index.md/log.md are excluded.
- Validation: only the selected folder's root index.md may declare `okf_version`. Other index metadata and all log.md frontmatter are rejected.
- Apply uses editor history; normal conflict-aware saving remains responsible for disk writes.
- Re-preview after any intervening edit.
- Properties preserve mixed line endings through the byte-aware model and shared undo history.
- Upkeep reports only. No asset deletion.

## Clean converted text

- **File → Clean converted text** opens a read-only preview. In Learning mode, use the same action in the Sheets rail or compact controls. **Back to source** or `Esc` closes it without applying. See [preview media](#preview-media).
- Show changes compares the changed Markdown range. Bake into source applies one undoable edit. Save/Autosave writes it normally; Undo restores the original Markdown.
- A change to the note or its disk revision requires a fresh preview.
- Built in: conservative dehyphenation, page furniture at explicit page breaks, headings, lists, pipe tables, adjacent captions and missing frontmatter. Existing frontmatter is preserved.
- Optional desktop hook: set `OMARKIE_CLEAN_SCRIPT` to an executable path or a JSON array of executable and arguments.
- The hook runs the installed Stage 2 p01–p07 CLI on a private UTF-8 scratch copy: `source.md --passes 1,2,3,4,5,6,7 --report report.json`. No pipeline code is bundled or copied.
- The hook receives no original path. Asset-dependent repairs cannot inspect the source folder. Failed hooks leave the document untouched; unset the hook to use the built-in cleanup alone.

## Learning mode

- Toggle **Learning mode** in the title bar, **Display**, or **Plugin Manager**. Shortcut: `Ctrl+Shift+Y` (`⌘⇧Y` on macOS). Saving study items and using Tutor require a saved note inside an open vault.
- Open **Sheets** in the left sidebar. At 820 px or less, sheet controls appear above the page as chips. Click a sheet to show or hide it, Alt-click to solo it, or click the pencil to make it active.
- **Live Preview** in Sheets switches the current note between rendered view and source without changing the global preference. The base stays locked in Learning mode.
- Tutor uses the right Payload slot. When Tutor is unavailable, including on a standalone note, enabled [Payload](#payload) still offers confirm-before-send questions. In a half tile, opening either right panel closes the Files drawer and vice versa.
- `Alt+Enter` focuses the selection actions. `N` note, `D` doubt, `W` correction, `A` ask, `E` explain back, `Q` quiz, `C` card, `P` propose.
- **Understanding** cycles each paragraph through not rated, lost, shaky and solid. Quiz feedback can set the same rating. Ratings are stored with the anchor, not in Markdown.
- **Search scraps** searches the whole vault. Electron and macOS match word prefixes across scrap text, questions, and anchor quotes in the current journal. Neither writes a separate index to disk.
- Click a paper tab to fold or unfold a note. Drag its tab or header to another paragraph, onto a note to stack, or into **Loose scraps**. **Move** also lets you click a paragraph.
- Drop a PNG, JPEG, GIF, or WebP onto the page, or paste a copied image. Drop to the left or right of the paragraph; text wraps around the picture.
- Drag the picture or its grip to move it. Drag the resize handle on the inner edge. **Peel off** removes the scrap; **Undo** restores it.
- **Write into note… → Accept** imports the image as a note asset and inserts `![label](path){width=240 float=right}`. Save the note as usual. Other Markdown apps can still render the image.
- Hold **Peek** to see the base page. Turn off Learning mode to edit Markdown.
- **Fold view** (`Ctrl+Shift+H`, `⌘⇧H` on macOS; also Display menu, toolbar overflow, Learning rail) replaces the page with a read-only fold of the note's own words and turns Learning mode on. Stops: Full, Brief, Key, Takeaway, Topic; opens at Key. Stop is session-only.
  - Keys: `[` `]` step, `1`-`5` jump, `↑` `↓` move between lines, `Esc` leaves to the fold's top line.
  - Drag the level bar or `Ctrl`+wheel to scrub between stops; release settles on the nearest. `Ctrl`+wheel over one unit folds only that unit.
  - Topic shows **Cards** or **Map** (toggle remembered): each section's lead line, author words only; tables, code, formulas and images as chips. Click or `Enter` opens that line at Key, at the same height. Cards: arrows move by card and row. Map: `↑` `↓` walk, `←` parent, `→` first child.
  - Lecture notes (a `![[x.m4a]]` embed plus `mm:ss.t` paragraphs): Topic lines and cards show `▶ mm:ss`; click or `Enter` opens at Key and plays from that second. The bar gets a play/pause button (`Tab` to it; `Space`/`Enter`). The playing paragraph is marked as it goes.
  - Estudio is disabled: it needs a model; local stops only for now. Short notes show **Too short to fold**.
- Minor edits reattach scraps at 0.8 similarity; missing or ambiguous anchors go to **Loose scraps**. Existing margin notes appear as scraps without rewriting history.
- **Export notes and cards** saves a separate Markdown copy for the vault. It never overwrites a file.
- Back up `.omarkie` with the vault. Image bytes live in `.omarkie/scraps/`; image placements and other study items live in `.omarkie/store.jsonl`.
- Opening a vault does not create a journal. Reading writes, rename, move, Undo and Trash share a lock across Omarkie processes, even before the first journal entry.
- File operations in writable subfolders can proceed if permissions prevent creating the lock and neither a journal nor a lock exists.
- Trash and macOS Undo Trash update the journal before moving the file. A crash between those steps can leave the file and history out of sync.
- Electron has no in-app Trash undo. On macOS, Undo restores reading history when the system returns a Trash location and the undo is still available.
- Omarkie attempts to purge detached history after successful Trash on Electron, or when macOS has no Trash undo, replaces it, or quits. If cleanup is recorded as pending in `.omarkie`, reopening the vault retries it. This does not erase earlier journal rows.
- A rename or move reports an error if it contains an unreadable tracked note. Missing notes retain their history at the old path.
- Anchoring model: [Hypothesis](https://web.hypothes.is/blog/fuzzy-anchoring/), BSD-2-Clause. No code copied.

### Tutor

- Open **Tutor** from the title bar, or select text and choose **Ask Tutor**.
- On Electron for Unix, **Local agent** is the default. Send the question, then run `omarkie-axi poll --wait` in the vault (or pass `--vault <dir>`). Only the paragraph, question, and local anchor go through the socket. No HTTP listener.
- Switch to **Payload** to use its existing opt-in, approved origin and privacy notice. No automatic fallback.
- One question at a time. **Stick on paragraph** saves the answer on the Tutor answers sheet.
- **Still lost** asks for a simpler answer and stacks it on the original when pinned. **Explain back** pins your explanation with Tutor feedback. **Exam points** and **Glossary** have dedicated sheets.
- **Check correction** opens Tutor with your proposed layer-only correction. A suggested base edit still requires **Accept into Markdown**.
- **Quiz me** asks one retrieval question. **Answer quiz** checks your answer. **Make it a card** opens the existing card editor with the Tutor reply.
- **Propose edit** saves a before/after draft on the Proposals sheet. **Reject** discards it. Only **Accept into Markdown** updates the note. Save as usual.
- Accept checks the exact paragraph, its position, and disk changes. A stale draft cannot write. Use normal **Undo** to revert an accepted edit in one step.

### Tutor CLI

- Arch: `omarkie-axi` on PATH. Other Linux builds: `omarkie-axi` beside the installed binary. From source: `npm run --silent omarkie-axi -- --help`.
- App closed: `doc view <note.md> --blocks` gives paragraph hashes. Use `scrap add`, `propose`, `scraps list`, or `proposals` against the same vault journal. No base Markdown writes.
- App running: `poll --wait`, `ask view <id> --full`, `status <id> working`, `reply <id> --text <answer>`. `poll --takeover` replaces the active listener.
- The socket starts on the first local ask and closes when leaving the document or turning off Learning mode. Open asks are session-only; saved scraps and proposals persist.
- `omarkie-axi setup hooks --vault <dir>` opts that project into Claude Code, Codex, and OpenCode 2 notices. Optional: `--agent <name>`. Put `omarkie-axi` on PATH and review the Codex hook with `/hooks`.
- Hooks announce pending ask count, not note text. Read the `omarkie-tutor` skill with `omarkie-axi skill`.
- Glass overlay state is per vault: `omarkie-axi glass [--on | --off] [--vault <dir>]` reads or sets `.omarkie/glass/vault.json` (the overlay toggle, beside the per-note magnet journals), and an open window follows the file live. `G` or the Display menu toggles the same state.
- With Glass on, hover for the element type or click to select. In the document, Tab and Shift+Tab walk elements; Enter focuses the actions, and Escape returns to the document.
- `omarkie-axi element list --note <note.md>` lists elements and their IDs. `omarkie-axi element show <id> --note <note.md>` shows one element's Markdown and heading path.
- Hover an element or select text, then **Comment** to open a bubble anchored to it. Type one question, open **X-ray preview** to see the exact text, heading path and neighbours that will leave the machine. Names, medical record numbers and birth dates are flagged wherever they appear in what would be sent (element text, quote, question, headings, neighbours), and **Send** stays blocked until each is removed or confirmed. **Send** asks the connected local agent; the reply threads in the bubble, and **Pin as cue card** saves a compact cue on the Tutor answers sheet. Without an agent the bubble stays a plain local comment.
- With Omarkie open, `omarkie-axi glass bubble add --note <note.md> --element <id> --text "<question>"` opens a bubble; `glass bubble list --pending` shows what waits for an agent; `glass bubble reply --note <note.md> --element <id> --text "<answer>"` answers the newest pending bubble on that element. Bubbles and threads persist in the magnet journal and survive restart.

### Preview media

- Learning mode and Clean block remote media even if editing allows it.
- Vault media and supported inline `data:` and page-created `blob:` media still render. In mixed image or audio/video sources, previews drop remote candidates and keep supported local fallbacks.
- Dropping an HTTPS image URL asks before sending a direct request to its origin. No note data, credentials, or redirects. Limit: 20 MB per image.

## Study cards

- Open a folder and a saved note. Select **Learning mode → Study cards**.
- **Make cards from highlights and notes** drafts up to 10 per note. Aim for 5–10; fewer distinct sources produce fewer cards.
- Edit the questions and answers. Save only the selected cards.
- For a single card, select text in Learning mode and choose **Make it a card**. Opening the composer saves nothing.
- **Test me** queues new and due cards across the open folder. Recall before revealing; then rate from 0 to 5.
- Ratings below 4 repeat in the session. Ratings below 3 restart the [SM-2](https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-obtained-in-working-with-the-supermemo-method) schedule.
- Cards and ratings stay in `.omarkie/store.jsonl`. The schedule is replayed from ratings. Source Markdown stays untouched.
- To save a Markdown copy, see [Learning mode](#learning-mode).
- [Obsidian Spaced Repetition](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/reviewing/) (MIT): review UI ideas only; no code copied.

## Reading images

- Unsized standalone images fill the reading column, up to 2× their natural width by default.
- Preferences → Image → Standalone image scale limit: choose 1.5× or **Off (natural size)** instead. Large images still fit the column.
- Explicit dimensions take precedence: Markdown `{width=N}`, wiki `![[image|N]]`, or HTML dimensions. Inline images do not upscale.
- Display only. Markdown, exports, and the full-window Image viewer are unchanged.

## Bounds

- Selected folder only; no symlink traversal or ancestor-vault grants.
- Existing tree inventory: 1,000 entries; depth 8.
- Reference scan: 8 MiB/note; 64 MiB text; 5 seconds.
- Assets: 50,000 entries; depth 12.
- Incomplete inventory is visible; copied bundle export refuses it.
- Duplicate/escaping/missing bundle targets must be fixed before export.
- Export creates a fresh directory outside the source vault.
- Notes/assets are copied; root index.md/log.md are real OKF documents.

## Vault bibliography

- Open a notes folder in the desktop app, then **File → Document tools → Writing and export**.
- **Import CSL JSON** saves one bibliography for that folder. To save pasted or edited CSL JSON, use **Save vault bibliography**. Without a folder, import and paste apply only to the current export.
- In either editor, type `[@` and a key, author, or title prefix. Choose a match with click, Enter, or Tab; use ↑/↓ to move and Escape to dismiss. The insertion is one undo step.
- In **Writing and export**, enable Vancouver citations to export with the saved bibliography, or edit the field for a one-off export.
- Vault bibliographies are stored in this app profile, keyed by the selected folder. They are not written into notes or shared with other profiles.

### Zotero

1. In Zotero with [Better BibTeX](https://retorque.re/zotero-better-bibtex/exporting/auto/) installed, export a collection as **Better CSL JSON** with **Keep updated** checked.
2. Choose **Link Zotero auto-export** and select that JSON file. Keep it at the same path. External changes refresh suggestions and exports while the vault is open; missing or malformed exports keep the last valid copy.
3. To include PDF paths, add this snippet under Better BibTeX → Export → Postscript before exporting:

   ```js
   if (Translator.BetterCSLJSON) {
     const pdfs = (zotero.attachments || []).map(a => a.localPath)
       .filter(file => typeof file === "string" && /\.pdf$/i.test(file));
     if (pdfs.length) csl["omarkie-pdf"] = pdfs;
   }
   ```

- Right-click `[@key]` → **Open cited PDF**, or place the caret in it and press Alt+Enter. The first valid local PDF opens in the system viewer. No Zotero API, remote URL, or PDF conversion.
- **Disconnect Zotero** retains the bibliography but disables live refresh and PDF opening. **Clear vault bibliography** removes the saved bibliography and link without changing the Zotero export.
- Limits: 2 MiB and 5,000 unique keys per export. Keep JSON with attachment paths private.

## Export

- Actual Pandoc citeproc; maintained official NLM/Vancouver style.
- Neutral configurable letterhead; actual DOCX or PDF.
- Converter options are structured and allowlisted. No arbitrary flags, filters or CSL paths.
- Citation or letterhead exports strip frontmatter from the export copy, not the note.
- PDF rendering blocks network access. Local images travel through the existing portable conversion path.
- Pandoc required for document-tool PDF and all citation/letterhead exports. No plain-text or textutil substitute for these.
- Templates persist locally; using one creates a separate draft.

## Project export

1. File → Document tools → Writing and export → Choose project folder.
2. Set a numeric YAML `order:` in each chapter, e.g. `order: 10`.
3. Enable Vancouver citations to reuse the saved vault bibliography. Set the letterhead in the same panel, then export as DOCX or PDF.
4. Save outside the project folder.

- Includes Markdown notes in subfolders. Lower numbers first; ties and unnumbered notes sort by relative path. Unnumbered notes come last. An incomplete folder scan blocks export.
- Uses open drafts, drops each chapter's frontmatter from the output, and leaves source files untouched.
- Local images resolve from their chapter, inside the project only. Remote images and symlinks are not read. See [diagram export](diagrams.md#export).
- One [Pandoc](https://pandoc.org/MANUAL.html#option--file-scope) conversion, bibliography and letterhead. Pandoc (GPL-2.0-or-later) is an external executable; no code copied.

## Reuse

- Markdown parsing: existing markdown-it, MIT.
- YAML CST/ranges: yaml, ISC; loaded with document tools.
- Markdown checks: markdownlint, MIT; loaded on request.
- Link/backlink model informed by Foam graph/workspace, MIT. No Foam source copied.
- Zotero interoperability: Better BibTeX (MIT), documented Better CSL JSON export and postscript APIs. Zettlr (GPL-3.0) citation UX reference only; no code copied.
- OKF: official v0.2 §§4, 8, 9, 11; https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Official producer inspected: https://github.com/GoogleCloudPlatform/open-knowledge-format
- Its Python package depends on cloud tooling; not installed or advertised as a validator.
- Structural validation follows the permissive spec: unknown types/fields and absent optional families are allowed.
- Document tools add no cloud service, analytics or telemetry.

## Payload

- Desktop: Preferences → Payload. Off by default; no background requests.
- Set the OpenAI-compatible base URL (default `http://127.0.0.1:11434/v1`) and model. The app appends `/chat/completions`.
- Optional API key: set it for the session. It stays in memory, scoped to the configured origin, never saved to disk.
- Non-loopback URLs require HTTPS and an explicit allowance for that scheme, host and port. To revoke, select its URL and uncheck the allowance. Redirects are refused.
- Select text or use the current note. Open **Payload**, review the destination and sensitive-data notice, then choose **Send text for summary**. Even local servers can forward requests.
- The recipe keeps decisions, thresholds, exceptions and red flags. Spanish by default; a question can ask for English. Output may be wrong; check it against the source.
- Input: up to 24 KB of text and a 1,000-character question. Output: up to 768 tokens for summaries, 384 for answers. Choose `max_completion_tokens` if your endpoint requires it.
- **Append as callout** is one undoable edit. Questions reuse the original text, not previous answers; only the latest answer stays visible. No request history, cache or telemetry.
- Reuse: Markdown preview uses the existing markdown-it parser (MIT). Single-question interaction inspired by DeepTutor (Apache-2.0); no code copied.
