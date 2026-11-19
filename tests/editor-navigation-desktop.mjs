import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { preview } from "vite";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
try {
  for (const action of ["opened", "wiki", "search"]) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-navigation-"))), vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
    await mkdir(vault); await mkdir(profile);
    const contents = ["# Start\n\n[[fallback#Destination|Go delayed]]\n\n## Ordinary\n", "# Fallback\n\n" + "source-only ".repeat(30000) + "\n\n## Destination\n\nSearch destination\n"];
    const documents = contents.map((content, index) => ({ id: index ? "fallback" : "start", path: path.join(vault, index ? "fallback.md" : "start.md"), name: index ? "fallback.md" : "start.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, encoding: "utf-8", lineEnding: "\n" }));
    for (const record of documents) await writeFile(record.path, record.content);
    await writeFile(path.join(profile, "session.json"), JSON.stringify({ version: 1, folder: vault, activeId: "start", documents }));
    const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en", OMARKIE_DEV_URL: server.resolvedUrls.local[0] });
    delete env.ELECTRON_RUN_AS_NODE;
    const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    try {
      const page = await application.firstWindow(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await fullSize(application, page);
      await expect(page.getByRole("heading", { name: "Start", exact: true })).toBeVisible();
      await expect(page.locator(".document-editor")).toHaveCount(1);
      let loading = false;
      await page.route("**/assets/codeMirror-*.js", async route => { loading = true; await delayed; await route.continue(); });
      const send = command => application.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send("app:command", command), command);
      if (action === "opened") await send({ action: "opened", document: documents[1], anchor: "destination" });
      else if (action === "wiki") await page.getByRole("link", { name: "Go delayed", exact: true }).click({ modifiers: ["ControlOrMeta"] });
      else {
        await send({ action: "global-search" });
        const dialog = page.getByRole("dialog", { name: "Search Folder Contents", exact: true });
        await dialog.getByRole("textbox").fill("Search destination");
        await dialog.getByRole("button", { name: /fallback\.md/ }).click();
      }
      await expect.poll(() => loading).toBe(true);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator(".document-editor:not([hidden]) .cm-content")).toHaveCount(0);
      release();
      const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content");
      await expect(source).toBeVisible({ timeout: 30000 });
      await expect(page.locator("#footer-word-count-label")).toHaveAttribute("title", new RegExp(`Line ${action === "search" ? 7 : 5}, Column 1`));
      await expect(source.locator(".cm-line").filter({ hasText: action === "search" ? "Search destination" : "## Destination" })).toBeInViewport();
      await send({ action: "opened", document: documents[1], line: 7 });
      await expect(page.locator("#footer-word-count-label")).toHaveAttribute("title", /Line 7, Column 1/);
      await send({ action: "opened", document: documents[0], line: 5 });
      await expect(page.locator("#footer-word-count-label")).toHaveAttribute("title", /Line 5, Column 1/);
      await page.locator(".source-toggle").click();
      await expect(page.getByRole("heading", { name: "Ordinary", exact: true })).toBeVisible();
      await send({ action: "opened", document: documents[0], line: 1 });
      await expect(page.locator("#footer-word-count-label")).toHaveAttribute("title", /Line 1, Column 3/);
      for (const record of documents) assert.equal(await readFile(record.path, "utf8"), record.content);
      assert.deepEqual(errors, []);
      console.log(`PASS: ${action} navigation survives delayed source readiness and preserves ordinary jumps`);
    } finally { release(); await application.close(); }
  }
} finally { await server.close(); }
