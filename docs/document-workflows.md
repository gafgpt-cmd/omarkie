# Document workflows

- File → Document tools: OKF, templates, citations, upkeep.
- File → Properties: preview one YAML property, then apply to draft.
- Ctrl/Cmd-click wiki links and tags in rich mode.
- Ambiguous targets list every candidate. Missing targets never create files.
- Heading fragments open their target line.
- Open a folder before vault search, linked mentions or graph.
- Graph loads only when opened. First 200 notes; full inventory still serves reports.

## Source safety

- Opening/saving existing notes never adds metadata.
- New notes declare generic `Reference`; no inferred domain type.
- Properties edit YAML node ranges, not a whole-document serializer.
- Unknown YAML fields/comments and body text remain unchanged.
- Cyclic YAML aliases stay intact; their value is source-edit-only in Properties.
- Note/folder make-ready previews each proposed change.
- Apply uses editor history; normal conflict-aware saving remains responsible for disk writes.
- Re-preview after any intervening edit.
- Properties preserve mixed line endings through the byte-aware model and shared undo history.
- Upkeep reports only. No asset deletion.

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
- Custom workflow exports strip frontmatter from the export copy, not the note.
- PDF rendering blocks network access. Local images travel through the existing portable conversion path.
- Pandoc required for citations. No plain-text or textutil substitute for citation exports.
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
- No cloud, AI service, analytics or telemetry added.
