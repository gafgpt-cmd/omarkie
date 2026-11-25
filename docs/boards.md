# Boards

Boards are optional Excalidraw diagrams. The add-on is **off by default**; enable **Boards (Excalidraw)** in Preferences. The Excalidraw module is lazy-loaded, so a vault that never opens a board pays no renderer cost.

- A board is one `kind: "board"` magnet on the Media layer.
- Its scene lives at `.omarkie/assets/boards/<magnet>.excalidraw.json`.
- Only `elements`, view settings and embedded `data:` files are stored. Collaborator maps, callbacks and external URLs are stripped.
- Draw, then the scene saves after a short pause; continuous drawing saves at most every 700 ms. Closing the board flushes a pending save.
- A corrupt scene opens blank, keeps the damaged file beside it as `.corrupt-<time>`, and does not overwrite it until the next save.

## Offline by default

The renderer points `EXCALIDRAW_ASSET_PATH` at the packaged `excalidraw-assets/` folder and removes Excalidraw's built-in esm.sh font fallback. Fonts are copied from the MIT package at build time. UIOptions hide library loading, scene loading and image export. Opening, drawing and saving a board makes no HTTP(S) request; a network monitor in the desktop test asserts that.

## Agent parity

```sh
omarkie-axi board add --note note.md --near "Paragraph" --title "Pathway"
omarkie-axi board open --note note.md --magnet <id>
```

`board add` needs the Media layer unlocked. `board open` asks the running window to show the board; it fails when Omarkie is closed.
