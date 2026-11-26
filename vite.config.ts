import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typoraPlugins } from "./scripts/plugin-build.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const excalidrawFonts = path.join(projectRoot, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const fontTypes: Record<string, string> = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

// Board add-on stays offline: its canvas fonts ship beside the renderer, never from a CDN.
function excalidrawAssets(): Plugin {
  let outDir = path.join(projectRoot, "dist");
  return {
    name: "omarkie-excalidraw-assets",
    configResolved(config) { outDir = path.resolve(projectRoot, config.build.outDir); },
    configureServer(server) {
      server.middlewares.use("/excalidraw-assets/fonts", (req, res, next) => {
        const relative = decodeURIComponent((req.url ?? "").replace(/^\/+/, ""));
        const file = path.resolve(excalidrawFonts, relative);
        if (!file.startsWith(excalidrawFonts) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", fontTypes[path.extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() { if (existsSync(excalidrawFonts)) cpSync(excalidrawFonts, path.join(outDir, "excalidraw-assets", "fonts"), { recursive: true }); },
  };
}

export default defineConfig({
  plugins: [react(), typoraPlugins(), excalidrawAssets()],
  base: "./",
  build: { target: "es2022", rollupOptions: { input: ["index.html", "project-diagrams.html"] } },
});
