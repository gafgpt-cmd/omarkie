import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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

// Phone companion: installable, and the whole renderer opens offline once loaded. The worker answers
// same-origin requests from its cache and never contacts another origin. Desktop hosts skip it.
function companionWorker(): Plugin {
  return {
    name: "omarkie-companion-worker",
    apply: "build",
    transformIndexHtml(html, context) {
      if (!context.filename.endsWith("index.html")) return html;
      return [{ tag: "link", attrs: { rel: "manifest", href: "./manifest.webmanifest" }, injectTo: "head" }, { tag: "meta", attrs: { name: "theme-color", content: "#363b40" }, injectTo: "head" }];
    },
    generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "icons/omarkie.svg", source: readFileSync(path.join(projectRoot, "design/icon.svg")) });
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify({
        name: "Omarkie", short_name: "Omarkie", start_url: "./", scope: "./", display: "standalone",
        background_color: "#ffffff", theme_color: "#363b40",
        icons: [{ src: "icons/omarkie.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      }, null, 2) });
      const files = Object.keys(bundle).filter(name => name.startsWith("assets/") && !name.endsWith(".map")).sort();
      const precache = ["./", "./index.html", "./manifest.webmanifest", "./icons/omarkie.svg", ...files.map(name => "./" + name)];
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "sw.js", source: `const cache = "omarkie-${version}";
const precache = ${JSON.stringify(precache)};
self.addEventListener("install", event => event.waitUntil(caches.open(cache).then(store => store.addAll(precache)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys()
  .then(keys => Promise.all(keys.filter(key => key.startsWith("omarkie-") && key !== cache).map(key => caches.delete(key))))
  .then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(caches.open(cache).then(async store => {
    const hit = await store.match(request, { ignoreSearch: true, ignoreVary: true }) ?? (request.mode === "navigate" ? await store.match("./index.html") : undefined);
    if (hit) return hit;
    const response = await fetch(request);
    // Board fonts and other late files join the cache the first time they load.
    if (response.ok && response.type === "basic") await store.put(request, response.clone());
    return response;
  }));
});
` });
    },
  };
}

export default defineConfig({
  plugins: [react(), typoraPlugins(), excalidrawAssets(), companionWorker()],
  base: "./",
  build: { target: "es2022", rollupOptions: { input: ["index.html", "project-diagrams.html"] } },
});
