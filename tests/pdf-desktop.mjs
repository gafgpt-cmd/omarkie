import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// A PDF opens as the Markdown copy an external converter makes; without a converter it can open in the PDF viewer.
const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-pdf-ui-")), pdf = path.join(root, "Clinical Atlas.pdf"), converter = path.join(root, "convert.cjs");
await writeFile(pdf, "%PDF-1.7\n");
await writeFile(path.join(root, "page.png"), await sharp({ create: { width: 40, height: 30, channels: 3, background: "#4a7" } }).png().toBuffer());
await writeFile(converter, `const fs = require("fs"), path = require("path"); const [file,, out] = process.argv.slice(2);
fs.mkdirSync(path.join(out, "_images"), { recursive: true }); fs.copyFileSync(${JSON.stringify(path.join(root, "page.png"))}, path.join(out, "_images", "page 1.png"));
fs.writeFileSync(path.join(out, path.basename(file, ".pdf") + ".md"), "# Clinical Atlas\\n\\n![Page 1](_images/page 1.png)\\n");`);
const passed = [], errors = [];
async function launch(name, extra, args) {
  const data = path.join(root, name); await mkdir(data);
  const { OMARKIE_PDF_CONVERTER: _, OMARKIE_DEV_URL: __, ELECTRON_RUN_AS_NODE: ___, ...base } = process.env;
  const searchPath = (base.PATH || "").split(path.delimiter).filter(folder => !existsSync(path.join(folder, process.platform === "win32" ? "pdf-md.exe" : "pdf-md"))).join(path.delimiter);
  const env = await isolatedEnvironment({ ...base, OMARKIE_DATA_DIR: data, OMARKIE_LANGUAGE: "zh", PATH: searchPath, ...extra });
  const application = await electron.launch({ args: [process.cwd(), ...headlessArguments, ...args], env, timeout: 30000 }), page = await application.firstWindow();
  page.on("pageerror", error => errors.push(error.message)); await fullSize(application, page);
  return { application, page };
}
let application;
try {
  ({ application } = await launch("converted", { OMARKIE_PDF_CONVERTER: JSON.stringify([process.execPath, converter]) }, [pdf]));
  let page = await application.firstWindow();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(page.locator(".document-title")).toContainText("Clinical Atlas.md", { timeout: 20000 });
  await expect(rich.getByRole("heading", { name: "Clinical Atlas" })).toBeVisible();
  await expect.poll(() => rich.locator("img").evaluateAll(images => images.length === 1 && images[0].naturalWidth === 40)).toBe(true);
  passed.push("A PDF passed at launch opens as its converted Markdown copy with its pictures");
  await application.close(); application = null;

  ({ application, page } = await launch("fallback", {}, []));
  await page.locator(".rich-document:visible").first().waitFor();
  await application.evaluate(({ app, dialog, shell }, file) => {
    globalThis.viewerOpened = null; globalThis.question = null;
    dialog.showMessageBox = async (_window, options) => { globalThis.question = options; return { response: 1 }; };
    shell.openPath = async target => { globalThis.viewerOpened = target; return ""; };
    app.emit("open-file", { preventDefault() {} }, file);
  }, pdf);
  await expect.poll(() => application.evaluate(() => globalThis.viewerOpened)).toBe(pdf);
  const question = await application.evaluate(() => globalThis.question);
  assert.deepEqual(question.buttons, ["取消", "在 PDF 阅读器中打开"]); assert.match(question.detail, /pdf-md/);
  passed.push("Without a converter the PDF is offered to the PDF viewer and opens there");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed }, null, 2));
} finally { await application?.close(); }
