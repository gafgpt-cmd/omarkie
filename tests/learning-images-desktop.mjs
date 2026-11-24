import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const tmp = await mkdtemp(path.join(os.tmpdir(), "omarkie-images-"));
const vault = path.join(tmp, "vault"), file = path.join(vault, "Field notes.md");
const first = "A contour line traces points of equal elevation. Lines close together show that the slope rises steeply. Wider spacing suggests gentler ground. Follow the contour lines around the summit to find a route that keeps roughly the same altitude.";
const second = "On a ridge, contour lines form a V or U that points downhill. In a valley, the V points upstream. Trace the river back toward its source to check the direction before marking a route. Compare the spacing below and above the saddle.";
const third = "A saddle sits between two higher points. From the saddle, climbs lead left and right, while the ground falls away in the other two directions. Mark the saddle on your map and use it as a reference point for the rest of the walk.";
const source = `# Reading a contour map\r\n\r\n${first}\r\n\r\n${second}\r\n\r\n${third}\r\n`;
const diagram = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="390" viewBox="0 0 640 390">
<rect width="640" height="390" fill="#dcead8"/><path d="M0 370C100 238 170 348 296 246S500 261 640 130" stroke="#3a8690" stroke-width="13" fill="none"/>
<g fill="none" stroke="#527452" stroke-width="3"><ellipse cx="295" cy="137" rx="220" ry="112" transform="rotate(-11 295 137)"/><ellipse cx="295" cy="137" rx="179" ry="85" transform="rotate(-11 295 137)"/><ellipse cx="295" cy="137" rx="137" ry="61" transform="rotate(-11 295 137)"/><ellipse cx="295" cy="137" rx="93" ry="38" transform="rotate(-11 295 137)"/><ellipse cx="295" cy="137" rx="46" ry="20" transform="rotate(-11 295 137)"/></g>
<g fill="#27443a" font-family="sans-serif" font-size="24"><text x="26" y="48">CONTOUR SKETCH</text><text x="280" y="144">842</text><text x="505" y="69">700</text><text x="540" y="102">600</text></g><path d="M531 337h68m-68-5v10m68-10v10" stroke="#27443a" stroke-width="3"/></svg>`;
const png = await sharp(Buffer.from(diagram)).png().toBuffer();
const hash = createHash("sha256").update(png).digest("hex"), base64 = png.toString("base64");
await mkdir(vault);
await writeFile(file, source);
const record = { id: "fixture", path: file, name: "Field notes.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(tmp, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }));
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: tmp, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ args: [process.cwd(), ...headlessArguments], env });
let app = await launch();
const qa = process.env.OMARKIE_QA_DIR;
try {
  let page = await app.firstWindow();
  const errors = [], requests = [];
  function observe() {
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
  }
  observe();
  const rich = () => page.locator(".document-editor:not([hidden]) .rich-document");
  const paragraph = text => rich().locator("p[data-cid]").filter({ hasText: text });
  const actualImage = label => rich().getByRole("img", { name: label, exact: true });
  const image = label => actualImage(label).locator("..");
  const button = (root, name) => root.getByRole("button", { name, exact: true });
  const sheets = () => page.getByRole("complementary", { name: "Sheets", exact: true });
  const sidecar = path.join(vault, ".omarkie"), blobs = path.join(sidecar, "scraps");
  const entries = async () => (await readFile(path.join(sidecar, "store.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).map(row => row.entry);
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function send(target, { name, payload = base64, kind = "drop", edge = "left", html }) {
    await target.evaluate((node, { name, kind, payload, edge, html }) => {
      const transfer = new DataTransfer();
      if (html) transfer.setData("text/html", html);
      else transfer.items.add(new File([Uint8Array.from(atob(payload), c => c.charCodeAt(0))], name, { type: "image/png" }));
      const rect = node.getBoundingClientRect();
      const event = kind === "paste" ? new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }) :
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: edge === "left" ? rect.left + 4 : rect.right - 4, clientY: rect.top + 8 });
      node.dispatchEvent(event);
    }, { name, kind, payload, edge, html });
  }
  const local = "Contour sketch.png", pasted = "Pasted figure.png", embedded = "Browser image";
  await resize(1440);
  await expect(paragraph(first)).toBeVisible();
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  await button(page, "Learning mode").click();
  await expect(button(sheets(), "Images")).toHaveAttribute("aria-pressed", "true");
  if (qa) {
    await page.keyboard.press("ControlOrMeta+,");
    const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
    await preferences.getByRole("combobox", { name: "Theme", exact: true }).selectOption("omarchy-dark");
    await button(preferences, "Done").click();
  }
  const firstText = () => paragraph(first).evaluate(node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.textContent.startsWith("A contour")) {
      const range = new Range(); range.setStart(text, 0); range.setEnd(text, 1);
      return range.getBoundingClientRect().left - node.getBoundingClientRect().left;
    }
    return -1;
  });
  const before = await firstText();
  await send(paragraph(first), { name: local });
  await expect(actualImage(local)).toBeVisible();
  await expect(image(local)).toHaveAttribute("data-side", "left");
  await expect.poll(firstText).toBeGreaterThan(before + 96);
  assert.deepEqual(await readFile(path.join(blobs, hash)), png);
  await send(paragraph(second), { name: pasted, kind: "paste" });
  await expect(actualImage(pasted)).toBeVisible();
  await expect(image(pasted)).toHaveAttribute("data-side", "right");
  await button(image(pasted), "Peel off").click();
  await expect(actualImage(pasted)).toHaveCount(0);
  await button(sheets(), "Undo").click();
  await expect(actualImage(pasted)).toBeVisible();
  await button(image(pasted), "Peel off").click();
  await expect(actualImage(pasted)).toHaveCount(0);
  await send(paragraph(third), { html: `<img alt="${embedded}" src="data:image/png;base64,${base64}">` });
  await expect(actualImage(embedded)).toBeVisible();
  assert.deepEqual(await readdir(blobs), [hash]);
  await button(image(embedded), "Peel off").click();
  await expect(actualImage(embedded)).toHaveCount(0);

  await send(paragraph(third), { html: '<img src="https://pictures.invalid/contour.png">' });
  const gate = page.getByRole("dialog", { name: "Download dropped image?", exact: true });
  await expect(gate).toContainText("https://pictures.invalid");
  await button(gate, "Cancel").click();
  await expect(gate).toHaveCount(0);
  await app.evaluate((_, base64) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url) !== "https://pictures.invalid/contour.png") return fetch(url, options);
      if (options.redirect !== "error" || options.credentials !== "omit" || options.body || options.method) throw new Error("Unsafe image request");
      return new Response(Buffer.from(base64, "base64"), { headers: { "content-type": "image/png" } });
    };
  }, base64);
  await send(paragraph(third), { html: '<img src="https://pictures.invalid/contour.png">' });
  await button(gate, "Download image").click();
  await expect(actualImage("contour.png")).toBeVisible();
  await button(image("contour.png"), "Peel off").click();
  await expect(actualImage("contour.png")).toHaveCount(0);

  const handle = button(image(local), "Resize image");
  const initialWidth = (await image(local).boundingBox()).width;
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 62, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const savedWidth = Math.round(initialWidth) + 62;
  const paragraphWidth = (await paragraph(first).boundingBox()).width;
  await expect.poll(async () => (await entries()).at(-1).image.width).toBe(savedWidth);
  await expect.poll(async () => (await image(local).boundingBox())?.width)
    .toBeCloseTo(Math.min(savedWidth, paragraphWidth / 2 - 12), 0);

  const target = await paragraph(second).boundingBox();
  await actualImage(local).dragTo(paragraph(second), { targetPosition: { x: target.width - 14, y: 13 } });
  await expect(paragraph(second).getByRole("img", { name: local, exact: true })).toBeVisible();
  await expect(image(local)).toHaveAttribute("data-side", "right");
  const placement = (await entries()).at(-1);
  assert.equal(placement.document, "Field notes.md");
  assert.equal(placement.anchor.line, 5);
  assert.equal(placement.anchor.hash.length, 64);
  assert.equal(placement.image.hash, hash);
  assert.equal(await readFile(file, "utf8"), source);
  if (qa) await page.screenshot({ path: path.join(qa, "learning-images-1440.png") });
  await resize(720);
  await expect(image(local)).toBeVisible();
  if (qa) await page.screenshot({ path: path.join(qa, "learning-images-720.png") });

  await app.close();
  app = await launch(); page = await app.firstWindow(); observe();
  await expect(paragraph(second).getByRole("img", { name: local, exact: true })).toBeVisible();
  await expect(image(local)).toHaveAttribute("data-side", "right");
  await button(sheets(), "Images").click();
  await expect(actualImage(local)).toHaveCount(0);
  await button(sheets(), "Images").click();
  await expect(actualImage(local)).toBeVisible();
  await button(image(local), "Write into note…").click();
  assert.equal(await readFile(file, "utf8"), source);
  assert.ok((await entries()).at(-1).type === "sheet");
  await button(image(local), "Accept").click();
  const accepted = rich().locator('img[data-image-float="right"]');
  await expect(accepted).toBeVisible();
  await expect(accepted.locator("xpath=../..")).toHaveCSS("float", "right");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toContain(`{width=${placement.image.width} float=right}\r\n\r\n${second}`);
  const saved = await readFile(file, "utf8");
  const reference = /!\[Contour sketch\.png\]\(([^)]+)\)/.exec(saved)[1];
  assert.deepEqual(await readFile(path.join(vault, decodeURIComponent(reference))), png);
  assert.equal(saved.replace(/!\[Contour sketch\.png\][^\r]+\r\n\r\n/, ""), source);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log("PASS: dropped and pasted blobs, wrap, pointer move and resize, restore, and explicit Markdown acceptance");
} finally { await app.close(); }
