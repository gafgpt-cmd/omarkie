# FORK.md

Fork of `AniChikage/open-typora`. Read before any change.

| Field | Value |
|---|---|
| Fork (origin) | `gafgpt-cmd/omarkie`, public |
| Upstream (push disabled) | `AniChikage/open-typora` (`https://github.com/AniChikage/open-typora.git`, `main`) |
| Sync owner | `sync-owner` role; see manifest configuration below |
| Last synced upstream | `7882902e709848335658d64e05c11c9b88ec590e` (`v0.12.0-4-g7882902`), 2026-10-20 (snapshot import into fresh root `5cedc37` / `efe8bed`; no shared git commit ancestry) |
| Rehearsal | `fork-sync rehearse`: throwaway merge, result telemetry scan, tests and optional fork rehearsal; no source checkout changes |
| Manifest | `fork.json` (not yet committed; schema below) |

Setup: `git remote add upstream https://github.com/AniChikage/open-typora.git` (read-only); `git remote set-url --push upstream DISABLED`; `git config rerere.enabled true`; `fork-sync init`, fill every `TODO`, commit `fork.json`.

## Manifest (`fork.json`)

Repo root, read by `fork-sync`.

| Key | Value |
|---|---|
| `schema` | `1` |
| `upstream` | `{"url": "https://github.com/AniChikage/open-typora.git", "branch": "main"}`: fetched read-only by URL; never pushed, no PRs/issues there |
| `fork_branch` | `main`: branch with our mods; sync PRs target it |
| `model` | `merge` only |
| `base` | last merged upstream sha; `apply` updates it |
| `sync_owner` | `sync-owner` role (also the default when unset); resolve through `FORK_SYNC_OWNER=<home id>` in config or environment; others `request` |
| `fork_only` | globs of our own files (`*` crosses `/`, trailing `/` = directory) |
| `seams` | upstream paths we edit, same globs; incoming commits that touch them = collision risk |
| `rehearse` | the fork's own rehearse command, or `null`; runs in the merge worktree with `<fork-sha> <upstream-sha>` appended |
| `test`, `lint` | shell commands run in the merged worktree, `null`, or `"from:.no-mistakes.yaml"` (`commands.<key>` on `fork_branch`) |
| `telemetry` | `policy` `removed`; `scan`: case-insensitive ERE on added lines, checked again on the completed merge relative to the fork tip; empty uses built-in patterns; `allow`: ERE on `path<TAB>text` clearing a reviewed false positive |

`seams`, `fork_only`, `telemetry.scan` and `telemetry.allow` are lists of nonempty single-line strings (or `null`/absent for an empty list). `fork.json` and `FORK.md` are excluded from the diff scan.

Exit: 0 ok/clean/no-op, 1 error, 2 usage or manifest, 3 not sync owner, 4 lock held, 5 safety refusal, 10 behind, 11 conflicts, 12 telemetry, 13 red. `--dry-run apply` still fetches and verifies in scratch, but creates no persistent sync branch, record commit, push or GitHub write. `--dry-run request` fetches without opening an issue; `--dry-run init` prints the scaffold without writing it.

## Upstream sync (for agents)

1. `fork-sync check` (exit 10 = behind), then `fork-sync rehearse`.
2. Review incoming changes only for telemetry/phone-home, security regressions and seam collisions. A telemetry/security finding blocks that graft and goes to the maintainer. A clean automated verdict does not replace this review.
3. Clean and reviewed: `fork-sync apply` (sync owner: `sync/upstream-<sha>` merge commit, base + log, lock issue, PR on origin); other environments `fork-sync request`.
4. Conflicts, telemetry or red: resolve only those on `sync/upstream-<sha>`, never rewrite a seam's intent. `rehearse` tests a fresh merge with rerere; `apply` verifies and publishes an existing resolution branch (without rerunning the optional fork rehearsal).
5. `apply` requires a successful origin fork-branch fetch and the committed manifest to match the fork branch, with no unpushed/diverged local fork history. Origin must be distinct from upstream, and every effective push URL must name origin. Another sync's open `upstream-sync` issue blocks publication; the PR closes the lock and request issues.
   - Fork-specific notes: `omarkie` is a public fork by decision, and its git history starts from a fresh root commit (`5cedc37`, 2026-10-21) rather than upstream commit ancestry. Until a graft establishes shared ancestry (or commits are ported by content), automated three-way `git merge` against `upstream/main` requires explicit ancestry handling.
6. Land the PR through no-mistakes with a merge commit, never squash, to preserve upstream ancestry once shared history exists. Never push upstream or use `--force`.

## Adoption audit

Done once when adopted, and again for every graft.

- Security check: 2026-10-21 (initial adoption `efe8bed`, `v0.1.0`) and continuous CI/no-mistakes review through `v0.2.3` (`9939ec2`); narrow preload/WebKit bridge, main-frame local-origin checks, DOMPurify HTML sanitization, symlink/path-traversal guards, digest-verified build/converter/dictionary downloads.
- Telemetry, analytics, phone-home: removed/blocked from code (not opted out). No analytics, crash reporting, or update checks. Removed/blocked outbound paths:
  - Electron Chromium spellcheck dictionary downloads redirected to local bundled `.bdic` files (`electron/main.mjs`; no Google dictionary host contacted).
  - Excalidraw board fonts bundled locally in build/dev (`vite.config.ts`; no CDN fetch).
  - Remote HTTP(S)/WS(S)/FTP(S) requests and embeds blocked by default in renderer and host (`electron/network.mjs`, `electron/main.mjs`, macOS WebKit content rule list).
  - Optional features that talk to external endpoints (LanguageTool grammar, PicGo upload, online image swap) stay off by default and send requests only on explicit user action.
- Outbound test: `npm test` (`tests/network.test.mjs`, `tests/privacy.test.mjs`, `tests/spellcheck.test.mjs`, `tests/glass-swap-egress.test.mjs`) and `npm run test:webkit` (offline WebKit content rule list, zero remote fixture requests); nothing unexpected connects out.

## Seams

Own mods live in fork-only files. Each upstream-file edit is minimal where possible and listed here in the same change (label `divergence`).

### Accounting (`7882902e70` vs `origin/main` `9939ec2`)

| Category | Count | Notes |
|---|---:|---|
| Upstream base files (`7882902e70`) | 182 | `AniChikage/open-typora` at `v0.12.0-4-g7882902` |
| Modified upstream files (seams) | 124 | Listed below by directory |
| Removed upstream files | 21 | Upstream brand/presentation/zh-only docs/samples; listed below |
| Unchanged upstream files | 37 | Byte-identical to `7882902e70` |
| Fork-only files | 515 | Own mods across `.` (4), `.github` (1), `design` (1), `docs` (32), `electron` (40), `native` (4), `packaging` (4), `scripts` (7), `shared` (82), `skills` (1), `src` (122), `tests` (209), `third-party` (8) |

### Modified upstream files (124)

#### Root (9)

| Upstream file | Our edit | Why |
|---|---|---|
| `.gitignore` | Ignore `dictionaries/` | Local dev Hunspell `.bdic` cache |
| `CONTRIBUTING.md` | Omarkie build, test suites, Arch/Linux/macOS/Windows packaging, release policy | Fork development and verification contract |
| `LICENSE` | Add Omarkie contributors copyright line alongside Open Typora | Preserve upstream MIT notice + fork attribution |
| `README.md` | Rewrite for Omarkie features, themes, Omarchy, installs, offline guarantees, perf targets | Fork user documentation |
| `index.html` | Omarkie title, light/dark icons, packaged build-identity metadata | Fork branding and About build identity |
| `package.json` | Package identity (`omarkie`), scripts, bundled fonts, offline/study/vault deps, build config | Fork packaging, features and test scripts |
| `package-lock.json` | Lockfile synced to fork `package.json` | Reproducible installs |
| `tsconfig.json` | Include `shared/fold-format.d.mts` | Typecheck fork `omarkie/fold` format module |
| `vite.config.ts` | Serve/copy Excalidraw fonts locally (`excalidrawAssets` plugin) | Keep board add-on fully offline (no CDN) |

#### `.github/` (4)

| Upstream file | Our edit | Why |
|---|---|---|
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Omarkie naming and fields | Fork issue intake |
| `.github/ISSUE_TEMPLATE/config.yml` | Point release link to `gafgpt-cmd/omarkie`; drop upstream parity link | Fork release/issue routing |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Omarkie naming | Fork issue intake |
| `.github/workflows/release.yml` | Add Arch package job, Linux RPM/DEB/AppImage checks, digest-verified Pandoc, Omarkie naming | Fork multi-platform release pipeline |

#### `design/` (2)

| Upstream file | Our edit | Why |
|---|---|---|
| `design/dmg-background.svg` | Omarkie DMG installer artwork | Fork branding |
| `design/icon.svg` | Omarkie M icon | Fork branding |

#### `docs/` (3)

| Upstream file | Our edit | Why |
|---|---|---|
| `docs/architecture.md` | Document Omarchy, offline network/WebKit guards, spellcheck, media grants, vault/perf tests | Reflect fork architecture |
| `docs/diagrams.md` | Document fork theme-colored Mermaid and legacy diagram support | Reflect fork diagram behavior |
| `docs/plugins.md` | Document 15 offline plugins (8 community + 7 reading ports) and host limits | Reflect fork plugin compatibility |

#### `electron/` (10)

| Upstream file | Our edit | Why |
|---|---|---|
| `electron/background.mjs` | Wrap error strings in `t(...)` | Multi-locale i18n (EN/ES/CA/RO/ZH) |
| `electron/image-actions.mjs` | i18n, Obsidian/vault image path resolution and hooks | Fork i18n and image workflows |
| `electron/interchange.mjs` | i18n, converter resolution, citation/project export, ODT/PDF hooks | Fork document conversion and export |
| `electron/launch-files.mjs` | Handle PDF/showcase/launch arguments | Fork startup and PDF open workflow |
| `electron/main.mjs` | Network request blocker, local spellcheck URL, Omarchy watcher, i18n, Showcase, Glass/Vault/Reader IPC, lazy-loaded feature modules + one-read photo bodies (perf budgets) | Core fork desktop host wiring |
| `electron/plugins.mjs` | i18n and fork plugin host hooks | Multi-locale i18n and reading plugins |
| `electron/preload.cjs` | Expose narrow IPC channels for fork features (Omarchy, Glass, Vault, Showcase, Reader, Git sync) | Restricted preload bridge |
| `electron/resources.mjs` | `omarkie-asset://` protocol, vault/Obsidian media lookup, symlink/size safety | Fork branding and local asset resolution |
| `electron/store.mjs` | i18n, recovery/session protection, vault/OKF/reading persistence, lazy legacy codec (perf budgets) | Fork file safety and document workflows |
| `electron/workspace.mjs` | i18n, collision-safe exclusive moves, streaming bounded vault search, undo | Fork i18n and vault safety |

#### `native/` (7)

| Upstream file | Our edit | Why |
|---|---|---|
| `native/App.swift` | Omarkie bundle/menus, offline WebKit content rule list, local media grant lifecycle, fork IPC | Fork macOS native host parity |
| `native/DocumentStore.swift` | Atomic save, pending media grants, recovery snapshot boundaries | Fork macOS file and media safety |
| `native/Interchange.swift` | Fork Pandoc/citation/project export handling | Fork macOS export parity |
| `native/PDFExporter.swift` | Image decode wait, offline rule list, project PDF settings | Fork macOS PDF reliability |
| `native/StoreTests.swift` | Tests for fork store, grants, exclusive move and recovery rules | Fork macOS native test coverage |
| `native/Workspace.swift` | `moveExclusive` (`renamex_np`), OKF new-note front matter, trash undo tracking | Collision-safe moves and OKF notes |
| `native/bridge.js` | Bridge fork commands/channels between WKWebView and AppKit | Fork macOS JS/Swift bridge |

#### `scripts/` (9)

| Upstream file | Our edit | Why |
|---|---|---|
| `scripts/dev.mjs` | `OMARKIE_DEV_URL` env var | Fork branding |
| `scripts/install.mjs` | `Omarkie.app` staging/rollback paths | Fork macOS local install |
| `scripts/package-dmg.mjs` | Omarkie DMG naming and checksums | Fork macOS release packaging |
| `scripts/package-linux.mjs` | Omarkie DEB/RPM/AppImage, Git build identity stamping, truncated-package verification | Fork Linux release packaging |
| `scripts/package-native.mjs` | Omarkie app bundle metadata, bundled resources, build identity | Fork macOS packaging |
| `scripts/package-windows.mjs` | Omarkie NSIS/ZIP packaging and checksums | Fork Windows packaging |
| `scripts/prepare-electron.mjs` | Select fork runtime deps, bundled dictionaries, showcase and CSL assets | Fork Electron packaging payload |
| `scripts/test-native.mjs` | Build/run updated `native/StoreTests.swift` | Fork macOS native test runner |
| `scripts/test-webkit.mjs` | Visible-window WebKit runner, offline/opted-in fixture isolation | Fork macOS WebKit test runner |

#### `shared/` (2)

| Upstream file | Our edit | Why |
|---|---|---|
| `shared/commands.json` | Add fork menus, shortcuts and commands (themes, fonts, showcase, reading/study, vault, workflows) | Single source of truth for cross-host commands |
| `shared/plugin-module.mjs` | i18n error string; expose observer/computed-style globals in plugin sandbox | i18n and reading plugin compatibility |

#### `src/` (48)

| Subdir | Upstream files | Our edit | Why |
|---|---|---|---|
| `src/` (12) | `src/App.tsx`, `src/background.ts`, `src/browserBackground.ts`, `src/features.css`, `src/host.ts`, `src/main.tsx`, `src/preferences.ts`, `src/styles.css`, `src/themes.ts`, `src/types.ts`, `src/useDocuments.ts`, `src/vendor.d.ts` | i18n, Toypora/Toyzetlr/Omarchy themes, independent font pickers, in-window Linux menu bar, Reading Layers/Glass workspace, Vault/OKF/Showcase/Reader state and styles, no restyle on unchanged theme CSS | Core fork UI, theming and workspace features |
| `src/components/` (13) | `src/components/BackgroundSettings.tsx`, `src/components/Dialog.tsx`, `src/components/EncodingDialog.tsx`, `src/components/FileTree.tsx`, `src/components/ImageDialog.tsx`, `src/components/InsertDialog.tsx`, `src/components/PluginsDialog.tsx`, `src/components/PreferencesDialog.tsx`, `src/components/QuickOpen.tsx`, `src/components/Sidebar.tsx`, `src/components/ThemePicker.tsx`, `src/components/Toolbar.tsx`, `src/components/WorkspaceDialog.tsx` | Wrap hardcoded Chinese strings in `t(...)`; add language/font/spellcheck/grammar/reading/vault/image controls and Omarchy theme options | Multi-locale i18n and fork UI dialogs/chrome |
| `src/demo/` (3) | `src/demo/DemoApp.tsx`, `src/demo/main.tsx`, `src/demo/samples.ts` | Omarkie branding, i18n, localized samples | Fork browser preview demo |
| `src/editor/` (15) | `src/editor/MarkdownEditor.tsx`, `src/editor/RichEditor.ts`, `src/editor/diagrams.ts`, `src/editor/htmlResources.ts`, `src/editor/images.ts`, `src/editor/legacyDiagrams.ts`, `src/editor/markdown.ts`, `src/editor/markdownExtensions.ts`, `src/editor/math.ts`, `src/editor/mathEngine.ts`, `src/editor/model.ts`, `src/editor/print.ts`, `src/editor/richRender.ts`, `src/editor/search.ts`, `src/editor/selectionCommands.ts` | i18n, offline remote-media blocking, Obsidian wikilinks/images/sizes, theme-colored diagrams, fast large-note rendering, one preconfigured sanitizer per config, reading/glass anchors, read-only lock timing | Fork editor privacy, performance, Obsidian/study compatibility |
| `src/plugins/` (5) | `src/plugins/catalog.ts`, `src/plugins/events.ts`, `src/plugins/runtime.ts`, `src/plugins/stateRecorder.ts`, `src/plugins/types.ts` | i18n, register 7 reading plugins + `auto_number`/`collapse_paragraph`, startup ordering and lifecycle guards | Fork offline plugin suite |

#### `tests/` (28)

| Upstream files | Our edit | Why |
|---|---|---|
| `tests/WebKitTests.swift`, `tests/alignment-desktop.mjs`, `tests/background-desktop.mjs`, `tests/background.test.mjs`, `tests/commands.test.mjs`, `tests/compatibility-desktop.mjs`, `tests/conversion.test.mjs`, `tests/desktop.mjs`, `tests/electron-shell.mjs`, `tests/encoding-desktop.mjs`, `tests/encoding.test.mjs`, `tests/export-resources.test.mjs`, `tests/features-desktop.mjs`, `tests/image-actions.test.mjs`, `tests/ime-desktop.mjs`, `tests/install.test.mjs`, `tests/interchange.test.mjs`, `tests/kernel-desktop.mjs`, `tests/kernel.test.mjs`, `tests/launch-files.test.mjs`, `tests/linux-install.mjs`, `tests/parity-desktop.mjs`, `tests/plugin-package-desktop.mjs`, `tests/plugins.test.mjs`, `tests/store.test.mjs`, `tests/webkit.js`, `tests/windows-install.ps1`, `tests/workspace.test.mjs` | Update branding (`Omarkie`/`omarkie-asset://`), locale-aware assertions, fork command/plugin/media/export expectations, DEB/AppImage/Windows/WebKit harness updates | Keep upstream regression suites green against fork behavior |

#### `third-party/` (1) & `web/` (1)

| Upstream file | Our edit | Why |
|---|---|---|
| `third-party/typora-plugins/provenance.json` | Add `auto_number.js` and `collapse_paragraph.js` hashes; update host note to Omarkie | Provenance for added bundled Typora plugins |
| `web/index.html` | Omarkie title and light/dark SVG favicons | Fork web demo branding |

### Removed upstream files (21)

| Directory | Removed files | Why |
|---|---|---|
| `.` (1) | `README.zh-CN.md` | Replaced by single English README (UI stays 5-locale) |
| `design/` (4) | `design/brand.md`, `design/presentation/editor-window.jpg`, `design/presentation/hero.html`, `design/spec.md` | Upstream Open Typora brand/presentation assets |
| `docs/` (9) | `docs/feature-parity.md`, `docs/images/editing-demo-poster.png`, `docs/images/editing-demo.gif`, `docs/images/hero.png`, `docs/introducing-open-typora.zh-CN.md`, `docs/rea-provenance.json`, `docs/release-notes.md`, `docs/research.md`, `docs/verification.md` | Upstream Open Typora promo/parity/zh-only docs replaced by `docs/showcase/` and fork docs |
| `examples/` (4) | `examples/a-quiet-morning.md`, `examples/clear-page.md`, `examples/clear-page.pdf`, `examples/welcome.md` | Replaced by illustrated `docs/showcase/` notes |
| `scripts/` (1) | `scripts/extract-typora-modules.mjs` | One-off upstream extraction helper |
| `shared/` (1) | `shared/samples.json` | Replaced by fork Showcase notes |
| `src/` (1) | `src/editor/mathMarkdown.ts` | Superseded by `shared/math-syntax.mjs` |

## Sync log

Newest first.

| Date | Upstream ref | Decision | Notes | Our PR |
|---|---|---|---|---|
| 2026-11-28 | `a1a04ae` (`v0.26.3`) | Deferred | Audited upstream vs `origin/main` (`9939ec2`) while adding `FORK.md`; upstream is 137 commits ahead of base; no sync in this PR | - |
| 2026-10-21 | `7882902e70` (`v0.12.0-4-g7882902`) | Adopted | Snapshot fork into Omarkie `0.1.0` (`5cedc37` / `efe8bed`); fresh git root (no shared commit ancestry); offline/privacy defaults and multi-locale i18n applied | - |
