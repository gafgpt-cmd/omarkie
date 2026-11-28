import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync } from "node:fs";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { wavInfo } from "../shared/voice.mjs";
import { speechWav } from "./lecture-audio.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-voice-"));
const vault = path.join(home, "vault"), doc = "voice.md", file = path.join(vault, doc);
const heading = "Talking points", first = "Recall the answer before looking it up.", second = "Leave a day before your next review.";
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${second}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");

// A stub hook: copies the WAV it receives, then answers by mode. Never a network process.
const heard = path.join(home, "heard.wav");
const stub = path.join(home, "stt.sh");
await writeFile(stub, `#!/bin/sh
set -eu
cp "$OMARKIE_STT_AUDIO" '${heard}'
case "\${OMARKIE_STT_MODE:-dictation}" in
  memo) printf 'Auscultate before the second dose.\\n' ;;
  ask) printf 'Why does spacing beat cramming?\\n' ;;
  lecture) printf 'Spaced practice fights forgetting.\\n' ;;
  *) printf 'Dictated into the sticky.\\n' ;;
esac
`, "utf8");
chmodSync(stub, 0o755);

const baseEnv = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_STT: stub });
delete baseEnv.OMARKIE_DEV_URL; delete baseEnv.ELECTRON_RUN_AS_NODE;
const noHook = { ...baseEnv }; delete noHook.OMARKIE_STT;
// Lectures split on pauses, so the fake microphone speaks: an 800 ms burst every 2 s.
const speech = path.join(home, "speech.wav");
await speechWav(speech, [[200, 1_000]], 2);
const media = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${speech}`];
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `${name}.png`) });
const fixtures = fileURLToPath(new URL("./fixtures/glass", import.meta.url));
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
}

async function grade(png) {
  return sharp(png).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function capture(page, name) {
  const pathName = path.join(evidence, `${name}.png`);
  await page.screenshot({ path: pathName });
  const baseline = path.join(fixtures, `${name}.png`);
  if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await copyFile(pathName, baseline); return; }
  const [fresh, expected] = await Promise.all([grade(pathName), grade(baseline)]);
  assert.equal(fresh.info.width, expected.info.width, `${name}: baseline width differs`);
  assert.equal(fresh.info.height, expected.info.height, `${name}: baseline height differs`);
  const a = fresh.data, b = expected.data;
  let sum = 0, changed = 0;
  for (let index = 0; index < a.length; index++) { const delta = Math.abs(a[index] - b[index]); sum += delta; if (delta > 32) changed += 1; }
  const mean = sum / a.length, fraction = changed / a.length;
  console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
  assert.ok(mean <= 8 && fraction <= 0.1, `${name}: drifted from baseline (mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%)`);
}

async function open(environment) {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments, ...media], env: environment });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { app, page, errors };
}
const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const trayOf = page => page.locator(".glass-tray");
async function ready(page) {
  await expect(richOf(page).getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
}
async function flip(page, label, settled) {
  const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await settled()) return;
    if (!(await item.isVisible().catch(() => false))) await page.getByRole("button", { name: "Display", exact: true }).click();
    await item.click();
    await page.waitForTimeout(150);
  }
  assert.ok(await settled(), `${label} did not settle`);
}
async function learning(page, on = true) {
  await flip(page, "Learning mode", async () => (await richOf(page).getAttribute("contenteditable")) === String(!on));
  await expect(richOf(page)).toHaveAttribute("contenteditable", String(!on));
}
async function glass(page, on = true) {
  await flip(page, "Glass overlay", async () => ((await page.locator(".glass-layer").count()) > 0) === on);
  await expect(page.locator(".glass-layer")).toHaveCount(on ? 1 : 0);
}
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
async function blockBox(page, text) {
  return page.evaluate(text => {
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, text);
}
async function clickBlock(page, text) {
  const box = await blockBox(page, text);
  assert.ok(box, `the paragraph "${text}" is on screen`);
  await page.mouse.click(box.x + 60, box.y + 8);
}

const firstRun = await open(baseEnv);
let { app, page, errors } = firstRun;
try {
  await resize(app, page, 1440);
  await ready(page);
  await learning(page);
  await glass(page);
  await expect(trayOf(page)).toBeVisible();

  // Dictation: mic tool, click a paragraph, speak, stop -> one sticky with the transcript.
  const tray = trayOf(page);
  await expect(tray.locator('[data-glass-tool="voice"]')).toHaveCount(1);
  await tray.locator('[data-glass-tool="voice"]').click();
  await clickBlock(page, second);
  await expect(page.locator('[data-voice-pill="recording"]')).toBeVisible();
  await expect(page.locator('[data-voice-pill="recording"]')).toHaveAttribute("data-voice-mode", "dictation");
  await page.waitForTimeout(1_200);
  await page.locator('[data-voice-stop="stop"]').click();
  await expect(page.locator(".glass-note").filter({ hasText: "Dictated into the sticky." })).toHaveCount(1);
  await expect.poll(async () => (await axi("glass", "list", "--note", doc)).magnets.find(magnet => magnet.fields?.text === "Dictated into the sticky."),
    { timeout: 15_000 }).toBeTruthy();
  const heardInfo = wavInfo(await readFile(heard));
  assert.deepEqual({ rate: heardInfo.rate, channels: heardInfo.channels, bits: heardInfo.bits }, { rate: 16_000, channels: 1, bits: 16 });
  await shot(page, "voice-sticky-light-1440");

  // Memo: audio stays in the vault, the transcript is the visible text and AXI lists it.
  await tray.locator('[data-glass-tool="memo"]').click();
  await clickBlock(page, first);
  await expect(page.locator('[data-voice-pill="recording"]')).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.locator('[data-voice-stop="stop"]').click();
  const memo = page.locator('[data-voice-memo]').first();
  await expect(memo).toBeVisible();
  await expect(memo.locator("[data-voice-text]")).toHaveText("Auscultate before the second dose.");
  await memo.locator("[data-voice-play]").click();
  await expect.poll(() => memo.getAttribute("data-voice-playing")).toBe("true");
  await memo.locator("[data-voice-play]").click();
  await expect.poll(() => memo.getAttribute("data-voice-playing")).toBeNull();
  const memoList = () => axi("memo", "list", "--note", doc);
  await expect.poll(async () => (await memoList()).count, { timeout: 15_000 }).toBe(1);
  const listed = await memoList();
  assert.equal(listed.memos[0].text, "Auscultate before the second dose.");
  assert.ok(listed.memos[0].duration > 0, "the memo keeps its duration");
  const assets = path.join(vault, ".omarkie", "assets");
  const audioList = async () => (await readdir(assets, { recursive: true })).filter(name => /voice-.*\.(webm|ogg|wav|mp3|m4a)$/.test(String(name)));
  await expect.poll(audioList, { timeout: 15_000 }).toHaveLength(1);
  const audioFiles = await audioList();
  assert.ok(existsSync(path.join(assets, String(audioFiles[0]))));
  await expect.poll(async () => JSON.stringify(await axi("find", "Auscultate")), { timeout: 15_000 }).toContain("Auscultate");

  // Bubble: the microphone only fills the question; X-ray still stands before Send.
  await tray.locator('[data-glass-tool="select"]').click();
  await expect(page.locator("[data-voice-pill]")).toHaveCount(0);
  const firstBox = await blockBox(page, first);
  await page.mouse.click(firstBox.x + 60, firstBox.y + 8);
  await expect(page.locator(".element-halo-pill")).toBeVisible();
  await page.locator('[data-element-action="comment"]').click();
  const panel = page.locator(".glass-bubble");
  await expect(panel).toBeVisible();
  const mic = panel.locator("[data-bubble-mic]");
  await expect(mic).toHaveAttribute("data-bubble-mic", "idle");
  await mic.click();
  await expect(mic).toHaveAttribute("data-bubble-mic", "recording");
  await page.waitForTimeout(1_200);
  await mic.click();
  await expect(panel.locator(".bubble-question textarea")).toHaveValue("Why does spacing beat cramming?");
  await panel.locator(".bubble-xray-toggle").click();
  await expect(panel.locator(".bubble-xray")).toBeVisible();
  await expect(page.locator("[data-bubble-send]")).toBeVisible();
  await shot(page, "voice-bubble-xray-light-1440");
  await page.locator(".bubble-close").click();
  await expect(panel).toHaveCount(0);

  // Lecture: one save, exactly one new note with a timestamped transcript, its sections and its audio beside it.
  await tray.locator('[data-glass-tool="lecture"]').click();
  await clickBlock(page, second);
  await expect(page.locator('[data-voice-pill="recording"]')).toHaveAttribute("data-voice-mode", "lecture");
  await page.waitForTimeout(1_200);
  await page.locator("[data-voice-mark]").click();
  await expect(page.locator("[data-voice-mark]")).toContainText("(1)");
  await page.waitForTimeout(2_000);
  await page.locator('[data-voice-stop="save"]').click();
  await expect(page.locator(".glass-notice")).toContainText("Saved", { timeout: 20_000 });
  const noteList = async () => (await readdir(vault, { recursive: true })).filter(name => /\.md$/.test(String(name)) && !String(name).startsWith(".omarkie"));
  await expect.poll(noteList, { timeout: 15_000 }).toHaveLength(2);
  const notes = await noteList();
  const lecturePath = path.join(vault, String(notes.find(name => !String(name).endsWith(doc))));
  const lecture = await readFile(lecturePath, "utf8"), lectureTitle = path.basename(lecturePath, ".md");
  assert.match(lecture, /^## 00:00$/m);
  assert.match(lecture, /^00:0\d\.\d Spaced practice fights forgetting\.$/m);
  assert.match(lecture, /type: Reference/);
  assert.ok(lecture.includes(`![[${lectureTitle}.m4a]]`), "the lecture embeds its audio");
  assert.ok((await stat(path.join(path.dirname(lecturePath), `${lectureTitle}.m4a`))).size > 0, "the audio sits beside the note");

  // Light and dark, wide and narrow.
  await page.evaluate(() => localStorage.removeItem("omarkie-theme"));
  await ready(page);
  await glass(page);
  await resize(app, page, 1440);
  await expect(page.locator('[data-voice-memo]').first()).toBeVisible();
  await capture(page, "voice-light-1440");
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await ready(page);
  await glass(page);
  await expect(page.locator('[data-voice-memo]').first()).toBeVisible();
  await capture(page, "voice-dark-1440");
  await resize(app, page, 720);
  await expect(page.locator('[data-voice-memo]').first()).toBeVisible();
  await capture(page, "voice-dark-720");
  await page.evaluate(() => localStorage.removeItem("omarkie-theme"));
  await ready(page);
  await glass(page);
  await resize(app, page, 720);
  await expect(page.locator('[data-voice-memo]').first()).toBeVisible();
  await capture(page, "voice-light-720");
  await resize(app, page, 1440);
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Without the hook there is no microphone anywhere: tray, palette and bubble agree.
const bare = await open(noHook);
try {
  const { app: bareApp, page: barePage, errors: bareErrors } = bare;
  await resize(bareApp, barePage, 1440);
  await ready(barePage);
  await learning(barePage);
  await glass(barePage);
  const tray = trayOf(barePage);
  await expect(tray).toBeVisible();
  await expect(tray.locator('[data-glass-tool="voice"]')).toHaveCount(0);
  await expect(tray.locator('[data-glass-tool="memo"]')).toHaveCount(0);
  await expect(tray.locator('[data-glass-tool="lecture"]')).toHaveCount(0);
  const firstBox = await blockBox(barePage, first);
  await barePage.mouse.click(firstBox.x + 60, firstBox.y + 8);
  await expect(barePage.locator(".element-halo-pill")).toBeVisible();
  await barePage.locator('[data-element-action="comment"]').click();
  await expect(barePage.locator(".glass-bubble")).toBeVisible();
  await expect(barePage.locator("[data-bubble-mic]")).toHaveCount(0);
  assert.deepEqual(bareErrors, []);
} finally { await bare.app.close(); }

assert.ok((await stat(stub)).isFile());
console.log("PASS: push-to-talk sticky, memo create/play/search, voice ask with X-ray, lecture note with sections and its m4a, hidden without hook, light/dark 1440/720");
