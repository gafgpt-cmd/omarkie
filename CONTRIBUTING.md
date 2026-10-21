# Contributing to Omarkie

Thanks for helping improve Omarkie. Small, focused contributions are easier to review and verify.

## Report a problem

Search [existing issues](https://github.com/gafgpt-cmd/omarkie/issues) first. A useful report includes:

- Omarkie version, operating system version, and CPU architecture.
- Steps to reproduce, expected behavior, and actual behavior.
- A minimal Markdown document and a screenshot when they help explain the problem.
- For input problems: input method, rich/source mode, editing location, and the key sequence.
- For import/export problems: source format, target format, and Pandoc version.

Remove personal information and credentials from examples.

## Set up development

Use Node.js 26 and npm. Linux and Windows builds use Electron; the macOS build needs macOS 14+ and the Xcode Command Line Tools. Install Pandoc for the complete conversion suites.

```sh
git clone https://github.com/gafgpt-cmd/omarkie.git
cd omarkie
npm ci
npm run dev:app
```

The development command launches Vite and an Electron host. `npm run dev` runs a browser preview whose Save action downloads a file; it does not exercise the native filesystem bridge.

## Make a change

1. Create a branch for one fix or feature.
2. Keep Markdown, selection, and undo behavior intact. Do not change existing documents as a side effect of rendering.
3. Add a regression test when fixing a data-loss, encoding, selection, or editing-history bug.
4. Run the checks relevant to your change and describe the results in the pull request.
5. Update user documentation when behavior or requirements change.

Core checks:

```sh
npm test
npm run build
```

Additional suites:

| Command | Coverage | Environment |
| --- | --- | --- |
| `npm run test:native` | File bytes, atomic saves, recovery, conflicts, and workspace operations | macOS |
| `npm run test:webkit` | Actual WKWebView, native bridge, document conversion, and PDF export | macOS + Pandoc |
| `npm run test:desktop` | Editing, images, saving, recovery, and export in Electron | macOS, Windows or Linux desktop |
| `npm run test:parity` | Multi-line list/code indentation, table keyboard operations, legacy diagrams and portable HTML | Electron desktop |
| `npm run test:kernel-desktop` | Code/formula editing, keyboard interactions, and mode history | macOS desktop |
| `npm run test:features` | Outline, tables, preferences, navigation, and writing modes | macOS desktop |
| `npm run test:alignment` | File workflows, themes, images, and conversion | macOS desktop + Pandoc |
| `npm run test:encoding` | Encoding conversion, save protection, composition, and image paste | macOS desktop |

Automated desktop suites use isolated temporary application data. To keep screenshots and reports outside the checkout, set `OMARKIE_QA_DIR` to an absolute output directory. Synthetic composition tests do not replace manual input-method checks.

## Build and install

On Linux x64, run `npm run package:linux` to create a DEB, an RPM, an AppImage and checksums in `release/linux/`. The RPM needs `rpmbuild` and `bsdtar`, which reads the package back to reject a truncated build; set `OMARKIE_LINUX_TARGETS` (for example `deb,AppImage`) to build a subset. On Arch, `npm run package:arch` builds a package for the shared `electronNN` runtime with `makepkg` into `release/arch/`; its launcher (`packaging/arch/omarkie`) reports a missing runtime and offers the install.

On macOS:

```sh
npm run package:mac
```

This creates `release/native/Omarkie.app` and a ZIP archive. Run `npm run package:release` to additionally create a drag-to-install DMG and `SHA256SUMS.txt`; the DMG wraps the same native application. To install it locally, quit the running application and run:

```sh
node scripts/install.mjs
```

Use `npm run package:preview` for a separate preview application and data directory when checking a change without touching your normal session. Native builds are locally signed, not Apple-notarized.

On Windows x64, run `npm run package:win` to create the NSIS EXE installer, ZIP, and checksums in `release/windows/`. The same original M icon is generated as a multi-resolution ICO. The Windows package contains only the two runtime file-bridge dependencies; frontend libraries are already bundled.

After packaging on Windows, `npm run test:windows` installs the EXE into an isolated temporary folder, runs the desktop suite against the installed executable, checks Unicode document arguments, single-instance opening and file-association registration, and uninstalls the application. It preserves recovery data. Evidence goes to `OMARKIE_QA_DIR` in the runner temporary directory. This is automated acceptance on a Windows Server runner, not a manual Windows 10/11 IME check.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/editor/` | Markdown model, rendering, source mapping, and edit transactions |
| `src/components/` | Dialogs and navigation |
| `native/` | AppKit/WebKit host, files, images, and conversion |
| `electron/` | Linux/Windows release host, development, and desktop regression |
| `shared/` | Commands and starter documents shared by the hosts |
| `tests/` | Unit, native, and desktop integration tests |
| `design/` | Original icon and design sources |

Read [the architecture](docs/architecture.md) before changing the editor or native bridge.

Do not commit generated bundles, test output, credentials, personal documents, or third-party proprietary source/assets. Contributions are licensed under the project's [MIT license](LICENSE); preserve existing third-party notices.

## Publish a release

Set the package version, commit the change, and push a matching `v<version>` tag. The [release workflow](.github/workflows/release.yml) builds on Ubuntu 22.04 x64, Windows x64 and Apple Silicon macOS runners, plus an `archlinux:base-devel` container for the Arch package. All four builds and required tests must pass before publication. Windows is installed and uninstalled; Linux tests the installed DEB and extracted AppImage payload, including recovery preservation on uninstall; Arch lints the package with `namcap` and installs it to prove pacman pulls in the Electron runtime. The publisher verifies combined checksums before publishing DMG, EXE, two ZIPs, DEB, RPM, Arch package, AppImage and `SHA256SUMS.txt`. Published assets are never overwritten by a rerun.

Changes on `main` run Linux/Windows acceptance without publishing; release notes are generated from merged pull requests. Linux builds use `npm run package:linux`; in an isolated Ubuntu x64 environment, `xvfb-run -a node tests/linux-install.mjs` installs/removes the DEB with sudo and runs both packaged payloads. Never run that installer test against your ordinary Linux installation.
