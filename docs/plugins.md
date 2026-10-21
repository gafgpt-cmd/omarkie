# Themes and plugin compatibility

Omarkie works with Typora-style CSS themes and runs a subset of the community plugins from [obgnail/typora_plugin](https://github.com/obgnail/typora_plugin). It does not load the complete plugin distribution.

## Included community plugins

Open **Display → Plugin Manager**, or use **Preferences → Manage plugins**. Plugins are off initially. Their enabled state and configuration persist locally. Enable a plugin to apply its default effect, use **Toggle effect** or its shortcut to change it, and disable it to unload it. Effect toggles are session state unless the upstream plugin explicitly saves its configuration.

| Plugin | Upstream file | Adapted behavior | Default shortcut |
| --- | --- | --- | --- |
| Auto numbering | `auto_number.js` | Numbers headings in the text, the sidebar outline and `[TOC]` with CSS counters; exported HTML/PDF keeps the numbers; **Plugin commands** toggles each scope and picks a layout (decimal from H1 or H2, Roman, CJK thesis style, none) | — |
| Fold sections | `collapse_paragraph.js` | Ctrl+click a heading to fold the blocks beneath it (Ctrl+Alt: sibling sections, Ctrl+Shift+Alt: all same-level sections); **Plugin commands** folds or expands every section; per-document session state | — |
| Fold lists | `collapse_list.js` | Click the triangle beside a list to show only its first item; optional per-document session state survives editor DOM refreshes | — |
| Read-only | `read_only.js` | Locks live editing, source, local code editors, undo and editing commands; document navigation and copying remain available | Mod+Alt+R |
| No images | `no_image.js` | Hides inline images; hover reveals them | Mod+Alt+I |
| Paragraph focus | `blur.js` | Blurs other top-level blocks; hover restores clarity | Mod+Alt+Shift+B |
| Static markers | `static_markers.js` | Keeps supported inline metadata visible, including emphasis and code delimiters | Mod+Alt+M |
| Dark inversion | `dark.js` | Applies the upstream root inversion filter in a light OS appearance | Mod+Alt+D |

Mod means Control on Linux and Windows, and Command on macOS. Reserved editor shortcuts and collisions with other loaded plugins are rejected. Use **Plugin settings** to adjust the JSON configuration, including `HOTKEY`. A loading failure displays its cause and releases resources owned through the compatibility API.

The eight upstream files are included unchanged under `third-party/typora-plugins`, pinned to commit `4a856129a9dbefaa963bfba4aacd3e5484bde60a`, with their MIT license and provenance. They are compiled as ordinary modules; the host does not use `eval` or enable `unsafe-eval`. Runtime adapters normalize a small set of DOM selectors and upstream CSS transition units.

## Installing another plugin

Use **Install local plugin**, review the trust notice, and choose either a UTF-8 `.js` / `.cjs` file of at most 1 MB or **Choose plugin folder**. Installation creates a managed, content-addressed module and leaves it disabled. Enable it explicitly. To uninstall, use **Remove plugin**; desktop copies go to the operating system Trash and the original source file stays intact.

Installed JavaScript is trusted application code, **not a sandbox**. It can access documents and the desktop bridge. Only install source you trust. macOS serves modules through its existing same-origin resource handler. The Electron host preserves the existing application origin and serves installed modules through a scoped, per-session authorized protocol. Neither host enables `eval`, Node integration or unrestricted remote script loading.

The entry is CommonJS exporting `module.exports.plugin`. A folder uses `index.js`, `index.cjs`, or the relative `main` path in its `package.json`. The installer collects JS/CJS/JSON/CSS files up to 64 files, 4 MB total, 1 MB each and 8 directory levels. Hidden entries and `node_modules` are skipped; symbolic links and entries outside the selected folder are refused. The original folder can be moved or deleted after installation.

Folder modules may use relative `require('./helper')`, `require('../config.json')`, or `require('./style.css')`; JSON returns a parsed value and CSS returns text for `style()` or `utils.insertStyle`. Shared dependencies are cached and circular CommonJS references are supported. CSS image/font URLs are not automatically embedded. This does not resolve npm dependencies or load the complete upstream distribution. Compatible `BasePlugin` lifecycle hooks are `prepare`, `init`, `style` (CSS string), `html` (sanitized), `hotkey`, `process` and `postprocess`; commands use `call`, and cleanup can use `destroy`. A simple `BaseCustomPlugin.callback(anchor)` entry is supported, but the upstream custom-plugin manager and all selector/hint conventions are not implemented.

The adapter provides style insertion/removal (`insertStyle`, `replaceStyle`, `getStyleText`), `exportHelper.register` (its `beforeExportToHTML` CSS is embedded in exported HTML/PDF; `afterExportToHTML` and native export hooks are accepted but not run), unwrapping `MutationObserver`/`ResizeObserver`/`IntersectionObserver`/`getComputedStyle` wrappers that disconnect on unload, `safeEval` as a no-eval stub, `compareVersion`, `chromeVersion`, `modifierKey`, `getPlugin/getPluginFn/callPluginFn`, `decorator.afterCall` (a missing target is a no-op), notifications, local settings updates, lifecycle/document events, basic selection and Markdown access, undoable text insertion/replacement, `File.lock/unlock/freshLock`, tracked document event listeners, and a small `$` helper. It does **not** provide Node built-ins, filesystem/process modules, Electron APIs, npm dependencies, the full jQuery API, or arbitrary Typora internals. Unsupported module requests fail visibly. Plugins using those interfaces require a port. Elements reached from `entities.eWrite`, `entities.eContent`, `querySelectorInWrite`, `querySelectorAllInWrite`, `document.body`, `document.querySelector`, event targets and their relatives are tracked: class, inline style and listener changes made through them are undone on unload. Direct global DOM mutations outside the tracked helpers remain the plugin author's cleanup responsibility.

### Events, commands and cleanup

The host distinguishes document-load events (`fileOpened`, `otherFileOpened`, `fileContentLoaded`, with a path argument) from `fileEdited`. Load notifications describe the newly active document; they do not fire on each keystroke. Provisional IME text does not trigger an edit notification; a completed commit exposes the current Markdown once, and cancellation exposes no temporary candidates. `eventHub.on/off`, `addEventListener/removeEventListener`, ordered listeners, `once`, and cross-plugin `emit/publishEvent` are available. `beforeToggleSourceMode` reports a mode request, which may wait for composition to finish; `afterToggleSidebar` reports its visible state. Async listener failures unload only the failing plugin.

`hotkeyHub.register/registerSingle/unregister/pause/resume` supports single shortcuts and arrays, with the same collision checks as `hotkey()`. Candidate-input key 229 and active composition never trigger host shortcuts. Both the Electron and the native macOS hosts give file/folder modules receive the same owned timer bindings, including relative helper modules. Timers created with the provided `setTimeout/setInterval` or `window` helpers stop on disable, failure or unload; `debounce` uses those owned timers. This tracking does not cover arbitrary global aliases, private workers or external asynchronous operations.

**Plugin commands** in the manager exposes `staticActions` and `getDynamicActions(anchor, meta)`, including labels, disabled/checked states and metadata passed to `call(action, meta)`. `settings.autoSave` persists top-level configuration changes. `stateRecorder` preserves registered truthy DOM state within the current app session, keyed by document and block; it is not a disk-persistence implementation of the complete upstream service.

On disable or failure, owned effects and read-only locks are released before awaiting `destroy()`. Pending asynchronous commands from that instance can no longer edit documents, reacquire locks, register tracked events/hotkeys/timers, or publish host events. A replacement instance owns its own lock; an older teardown cannot unlock it. Arbitrary JavaScript and direct global DOM writes are still outside this lifecycle guard.

Document mutations through the host adapter are blocked while an IME composition is pending, with a notice to finish input first. A plugin must retry after commit; direct DOM writes by trusted JavaScript remain outside this protection.

For example, this independent single-file plugin adds an undoable edit:

```js
class InsertDate extends BasePlugin {
  call() {
    this.utils.insertText(new Date().toISOString().slice(0, 10))
  }
}
module.exports = { plugin: InsertDate }
```

## Themes

Preferences lists 17 built-in themes with live previews: Plain White, Warm Paper, Mist Ink, Graphite, Deep Sea, Pine Night, Toypora, Toypora Night, Toypora × Omarchy, Toyzetlr, Toyzetlr Night, Omarchy, Omarchy × Toypora, Omarchy Dark, Omarchy Light, Rosé Pine and Rosé Pine Dawn. The Omarchy themes follow the live Omarchy palette and font. **Preferences → Fonts** overrides the text, heading, code and interface fonts of any theme; the fonts are bundled with the app. Theme and font choices persist locally and are included in exported HTML/PDF styles.

Custom CSS installation supports local CSS imports plus referenced fonts and images. Resources are embedded, with depth/size limits and checks against directory traversal and symlink escapes. Remote resources must be downloaded first. Basic `#write`, `#typora-sidebar` and `.md-fences` selectors are adapted, along with common palette variables. This is **partial Typora theme compatibility**; no claim is made that every third-party theme renders identically.

### Personal background images

In **Preferences → Background image**, choose a local PNG, JPEG or WebP image, up to 8 MB and 40 million pixels. The app stores a copy, so moving or deleting the original does not break the background. No upload or image-host service is involved. The image applies to the editing area in both live and source modes, across all themes.

Opacity, blur, fill/fit/tile and position update immediately. **Reset effects** restores 18% opacity, no blur, centered fill; **Clear background** restores the theme background without changing the source image or document. Settings and the managed copy persist after restart; desktop windows share the same image and settings. Failed or cancelled selections retain the previous background. The browser preview stores its copy in IndexedDB.

Personal backgrounds are excluded from exported HTML, PDF and converted documents. Backgrounds defined inside an imported CSS theme still follow that theme's export styles.

## Verification scope

Tests execute the pinned upstream sources, exercise lifecycle cleanup, failed dependencies, real DOM effects, read-only guards, installation integrity and theme assets. The native WebKit suite additionally imports an installed CommonJS module under the actual script policy and checks an undoable document edit. Passing these checks does not establish compatibility with every third-party plugin, theme, input method or operating system.
