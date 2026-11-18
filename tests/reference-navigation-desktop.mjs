import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const failures = [];
for (const scope of ["outside", "omitted", "indexed"]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reference-navigation-"))), vault = path.join(root, "vault"), profile = path.join(root, "profile");
  const directory = scope === "outside" ? path.join(root, "outside") : scope === "omitted" ? path.join(vault, ...Array.from({ length: 10 }, (_, index) => `level-${index}`)) : vault;
  for (const folder of [vault, profile, directory]) await mkdir(folder, { recursive: true });
  const file = path.join(directory, "source.md"), sibling = path.join(directory, "sibling.md"), escape = path.resolve(directory, "../escape.md");
  const content = "# Source\n\n[Sibling link](sibling.md)\n\n[[sibling#Target|Wiki target]]\n\n[Escape](../escape.md)\n\n[[100% sure|Literal percent]]\n\n[[name%20literal|Encoded-looking percent]]\n\n[[sibling#Target alias|Alias heading]]\n".replace(/\n/g, scope === "indexed" ? "\r" : "\n");
  const record = { id: "source", path: file, name: "source.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, encoding: "utf-8", lineEnding: scope === "indexed" ? "\r" : "\n" };
  await writeFile(file, content); await writeFile(sibling, "# Sibling\n\n## Target\n\n## [[100% sure|Target alias]]\n"); await writeFile(escape, "# Escape target\n");
  for (const [name, title] of [["100% sure.md", "Literal percent target"], ["name%20literal.md", "Encoded-looking target"], ["name literal.md", "Wrong decoding"]]) await writeFile(path.join(directory, name), `# ${title}\n`);
  await writeFile(path.join(profile, "session.json"), JSON.stringify({ version: 1, folder: vault, activeId: record.id, documents: [record] }));
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en" });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
  try {
    const page = await application.firstWindow(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await fullSize(application, page);
    const rich = page.locator(".document-editor:not([hidden]) .rich-document");
    const source = async () => {
      await application.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows()[0].webContents.send("app:command", { action: "opened", document: record }), record);
      await expect(rich.getByRole("heading", { name: "Source", exact: true })).toBeVisible();
    };
    await expect(rich.getByRole("heading", { name: "Source", exact: true })).toBeVisible();
    await rich.getByRole("link", { name: "Sibling link", exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await expect(rich.getByRole("heading", { name: "Sibling", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Document tools", exact: true })).toHaveCount(0);
    await source();
    if (scope === "indexed") {
      await rich.getByRole("link", { name: "Wiki target", exact: true }).click({ modifiers: ["ControlOrMeta"] });
      await expect(rich.getByRole("heading", { name: "Target", exact: true })).toBeVisible();
      await expect(page.locator("#footer-word-count-label")).toHaveAttribute("title", /Line 3, Column/);
      await source();
      for (const [name, heading] of [["Literal percent", "Literal percent target"], ["Encoded-looking percent", "Encoded-looking target"], ["Alias heading", "Target alias"]]) {
        await rich.getByRole("link", { name, exact: true }).click({ modifiers: ["ControlOrMeta"] });
        if (name === "Alias heading") {
          const target = rich.locator("h2#target-alias");
          await expect(target).toBeVisible();
          await expect(target.locator(".md-view a")).toHaveText(heading);
          await expect(page.locator("#footer-word-count-label")).toHaveAttribute("title", /Line 5, Column/);
        } else await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await source();
      }
    }
    await rich.getByRole("link", { name: "Escape", exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("dialog", { name: "Document tools", exact: true }).getByRole("alert").filter({ hasText: "The link is outside the current document's folder." }).or(page.getByText("Link status: Link points outside the vault", { exact: true }))).toBeVisible();
    await expect(rich.getByRole("heading", { name: "Source", exact: true })).toBeVisible();
    await expect(rich.getByRole("heading", { name: "Escape target", exact: true })).toHaveCount(0);
    assert.equal(await readFile(file, "utf8"), content); assert.deepEqual(errors, []);
    console.log(`PASS: ${scope} note navigation retains sibling access and containment`);
  } catch (error) { failures.push(error); console.error(`${scope}: ${error.message}`); }
  finally { await application.close(); }
}
if (failures.length) throw new AggregateError(failures, "reference navigation regressions");
