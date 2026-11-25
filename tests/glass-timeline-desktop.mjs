import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

function wav(seconds = 0.18, rate = 8_000) {
  const samples = seconds * rate, data = Buffer.alloc(samples, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString("base64");
}

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-timeline-"));
const vault = path.join(home, "vault"), doc = "lecture.md", file = path.join(vault, doc);
const note = `# Lecture

<audio controls src="data:audio/wav;base64,${wav()}"></audio>

[00:00.000] Opening idea about retrieval.

[00:00.120] Second idea about spacing.
`;
await mkdir(vault);
await writeFile(file, note, "utf8");
const session = { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
  content: note, savedContent: note, diskHash: "0".repeat(64), lineEnding: "\n" }] };
await writeFile(path.join(home, "session.json"), JSON.stringify(session), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_EVIDENCE;

async function open() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.reload();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: "Lecture", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  const learning = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
  if ((await learning.getAttribute("aria-checked")) !== "true") await learning.click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.desktop.glassState({ action: "write", visible: true }));
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Lecture", exact: true })).toBeVisible();
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  return { app, page, errors };
}

async function capture(page, name) {
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, `glass-g19-timeline-${name}.png`) }); }
}

{
  const { app, page, errors } = await open();
  try {
    await page.locator('[data-glass-tool="timeline"]').click();
    const timeline = page.locator(".glass-timeline");
    await expect(timeline).toBeVisible();
    await expect.poll(() => page.locator(".glass-timeline-transcript button").count()).toBe(2);
    await expect.poll(() => page.evaluate(() => document.querySelector(".glass-timeline audio")?.duration ?? 0)).toBeGreaterThan(0.17);
    await expect(timeline).toHaveAttribute("aria-label", /Timeline/);

    const second = page.locator('[data-glass-cue="1"]');
    await second.click();
    await expect.poll(() => page.evaluate(() => (document.querySelector(".glass-timeline audio")?.currentTime ?? 0))).toBeGreaterThan(0.09);
    await expect(second).toHaveAttribute("aria-current", "true");

    await page.locator("[data-glass-pin-here]").click();
    await expect(page.locator("[data-glass-timestamp]")).toHaveCount(1);
    const pin = page.locator("[data-glass-timestamp]").first();
    const label = await pin.getAttribute("aria-label");
    assert.match(label, /00:00/);
    await expect(pin).toHaveAttribute("data-active", "true");
    await page.evaluate(() => { const audio = document.querySelector(".glass-timeline audio"); if (audio) audio.currentTime = 0; });
    await pin.click();
    await expect.poll(() => page.evaluate(() => document.querySelector(".glass-timeline audio")?.currentTime ?? 0)).toBeGreaterThan(0.09);
    await expect(second).toHaveAttribute("aria-current", "true");

    await timeline.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.evaluate(() => document.querySelector(".glass-timeline audio")?.currentTime ?? 0)).toBeGreaterThan(0.17);
    await capture(page, "light-1440");

    await page.evaluate(() => document.documentElement.dir = "rtl");
    await capture(page, "rtl-1440");
    await page.evaluate(() => document.documentElement.dir = "ltr");
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

{
  const { app, page, errors } = await open();
  try {
    await expect(page.locator(".glass-timeline")).toBeVisible();
    await expect(page.locator("[data-glass-cue]")).toHaveCount(2);
    await expect(page.locator("[data-glass-timestamp]")).toHaveCount(1);
    assert.deepEqual(errors, []);
    console.log("PASS: timeline glass pins, transcript links and seeks both ways");
  } finally { await app.close(); }
}
