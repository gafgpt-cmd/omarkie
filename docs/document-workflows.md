# Document workflows

- File → Document tools: OKF, templates, citations, upkeep.
- File → Properties: preview one YAML property, then apply to draft.
- Ctrl/Cmd-click wiki links and tags in rich mode.
- Ambiguous targets list every candidate. Missing targets never create files.
- Heading fragments open their target line.
- Open a folder before vault search, linked mentions or graph.
- Graph loads only when opened. First 200 notes; reports use the bounded inventory below.

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

- File → Clean converted text, or Reading Layers → Clean, opens a read-only preview. Back to source or Esc hides it without applying.
- Show changes compares the changed Markdown range. Bake into source applies one undoable edit. Save/Autosave writes it normally; Undo restores the original Markdown.
- A change to the note or its disk revision requires a fresh preview.
- Built in: conservative dehyphenation, page furniture at explicit page breaks, headings, lists, pipe tables, adjacent captions and missing frontmatter. Existing frontmatter is preserved.
- Optional desktop hook: set `OMARKIE_CLEAN_SCRIPT` to an executable path or a JSON array of executable and arguments.
- The hook runs the installed Stage 2 p01–p07 CLI on a private UTF-8 scratch copy: `source.md --passes 1,2,3,4,5,6,7 --report report.json`. No pipeline code is bundled or copied.
- The hook receives no original path. Asset-dependent repairs cannot inspect the source folder. Failed hooks leave the document untouched; unset the hook to use the built-in cleanup alone.

## Reading Layers

- Open a vault folder and a saved Markdown file in either desktop app. Open **Reading Layers** in the status bar.
- Eyes show or hide layers per document. The pencil marks the active layer. L0 is locked; close the rail to edit the source.
- Remote media stays off in the reader, even if enabled for editing.
- Select text in the reader to pin a margin note, open a Payload follow-up, or draft a card. `Alt+Enter` focuses the selection actions. Payload only sends when you confirm in its panel.
- Click a note's quote to jump to its block. Minor edits reattach at 0.8 similarity; missing or ambiguous blocks go to **Orphaned notes**. Nothing is auto-deleted.
- **Export notes and cards** saves a Markdown copy for the open vault. It never overwrites a file.
- Back up `.omarkie/` with the vault. `store.jsonl` is the journal; `index.json` is rebuilt from it.
- Anchoring model: [Hypothesis](https://web.hypothes.is/blog/fuzzy-anchoring/), BSD-2-Clause. No code copied.

## Study cards (L5)

- Open a folder and a saved note. Select **Reading Layers → Cards**.
- **Make cards from highlights and notes** drafts up to 10 per note. Aim for 5–10; fewer distinct sources produce fewer cards.
- Edit the questions and answers. Save only the selected cards.
- For a single card, select text in Reading Layers and choose **Make it a card**. Opening the composer saves nothing.
- **Test me** queues new and due cards across the open folder. Recall before revealing; then rate from 0 to 5.
- Ratings below 4 repeat in the session. Ratings below 3 restart the [SM-2](https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-obtained-in-working-with-the-supermemo-method) schedule.
- Cards and ratings stay in `.omarkie/store.jsonl`. The schedule is replayed from ratings. Source Markdown stays untouched.
- Use **Export notes and cards** in the margin notes panel for a Markdown copy.
- [Obsidian Spaced Repetition](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/reviewing/) (MIT): review UI ideas only; no code copied.

## Reading images

- Unsized standalone images fill the reading column, up to 2× their natural width by default.
- Preferences → Image → Standalone image scale limit: change the cap or choose **Off (natural size)**. Large images still fit the column.
- Explicit Markdown `{width=N}`, wiki `![[image|N]]`, and HTML `width` take precedence. Inline images keep their size.
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

## Export

- CSL JSON bibliography; `[@key]` citations.
- Actual Pandoc citeproc; maintained official NLM/Vancouver style.
- Neutral configurable letterhead; actual DOCX or PDF.
- Converter options are structured and allowlisted. No arbitrary flags, filters or CSL paths.
- Citation or letterhead exports strip frontmatter from the export copy, not the note.
- PDF rendering blocks network access. Local images travel through the existing portable conversion path.
- Pandoc required for document-tool PDF and all citation/letterhead exports. No plain-text or textutil substitute for these.
- Templates persist locally; using one creates a separate draft.

## Reuse

- Markdown parsing: existing markdown-it, MIT.
- YAML CST/ranges: yaml, ISC; loaded with document tools.
- Markdown checks: markdownlint, MIT; loaded on request.
- Link/backlink model informed by Foam graph/workspace, MIT. No Foam source copied.
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
- Input: 24 KB of text. Output: up to 768 tokens for summaries, 384 for answers. Choose `max_completion_tokens` if your endpoint requires it.
- **Append as callout** is one undoable edit. Questions reuse the original text, not previous answers; only the latest answer stays visible. No request history, cache or telemetry.
- Reuse: Markdown preview uses the existing markdown-it parser (MIT). Single-question interaction inspired by DeepTutor (Apache-2.0); no code copied.
