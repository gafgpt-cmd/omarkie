import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import sharp from "sharp";
import { createTranslator } from "../shared/i18n.mjs";
import { lectureNote, transcriptStamp } from "../shared/voice.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { readWork, stableHost, watchWork } from "./frame-cadence.mjs";
import { burstOnsets, speechWav } from "./lecture-audio.mjs";

// OM-124 Clase plegada: a recorded lecture becomes one note with its audio beside it; in Fold, a Topic card or line
// plays that audio from the second its words were spoken, and nothing leaves the machine.
const baselines = fileURLToPath(new URL("./fixtures/fold-lecture/", import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), "omarkie-lecture-"));
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(work, "shots");
await mkdir(evidence, { recursive: true });
// The proof row: a card click lands within 200 ms of the spoken sentence.
const LANDING_MS = 200;

// Four "sentences" two seconds apart, so each is its own paragraph; the fake microphone loops the file.
// Each transcript is long enough that the note is worth folding (80 words).
const speech = path.join(work, "speech.wav");
await speechWav(speech, [[600, 1_900], [3_900, 5_200], [7_200, 8_600], [10_600, 11_800]], 13);
const sentences = [
  "Spaced practice fights forgetting across a long course. Each review comes a little later than the last one, so recall stays effortful and the memory grows stronger.",
  "Retrieval beats rereading when the exam is weeks away. Close the notes, write what you remember, then check the gaps against the source before moving on.",
  "Interleave topics so each review starts with a question. Mixing problem types forces you to choose the method, which is the skill the exam actually tests.",
  "Sleep keeps what you learned during the day. A short review before bed and another the next morning hold more than one long session the night before."];
const stub = path.join(work, "stt.sh"), count = path.join(work, "count");
await writeFile(stub, `#!/bin/sh
set -eu
n=$(cat '${count}' 2>/dev/null || echo 0)
echo $((n + 1)) > '${count}'
case "$n" in
${sentences.map((sentence, index) => `  ${index === sentences.length - 1 ? "*" : index}) printf '${sentence}\\n' ;;`).join("\n")}
esac
`, "utf8");
chmodSync(stub, 0o755);

// The screenshot lecture: fixed words and times, so baselines never depend on the clock or the recording.
const DEMO = "Clase plegada";
const demo = lectureNote({ title: DEMO, audio: `${DEMO}.m4a`, at: "2026-01-05T09:00:00.000Z", marks: [{ atMs: 3_900 }, { atMs: 7_300 }], segments: [
  { startMs: 400, endMs: 2_600, text: "La práctica espaciada combate el olvido a lo largo de un curso. Cada repaso llega un poco más tarde que el anterior." },
  { startMs: 3_000, endMs: 3_700, text: "Cada repaso empieza con una pregunta, nunca releyendo los apuntes de principio a fin." },
  { startMs: 4_100, endMs: 6_000, text: "Recuperar de memoria supera a releer los apuntes, sobre todo semanas antes del examen. Cierra el libro, escribe lo que recuerdas y compara después." },
  { startMs: 7_600, endMs: 8_800, text: "Con 120 alumnos, intercalar temas mejoró la nota final. Mezclar tipos de problema obliga a elegir el método." },
  { startMs: 10_500, endMs: 11_600, text: "Dormir consolida lo aprendido durante el día. Un repaso breve antes de dormir y otro por la mañana rinden más que una sesión larga la víspera." },
] });
const SOURCE = "Today we review long-term memory.";
const source = `# Review\n\n${SOURCE}\n`;
const demoAudio = path.join(work, `${DEMO}.m4a`);

async function launch(language, record) {
  const home = await mkdtemp(path.join(work, `${language}-`)), folder = path.join(home, "vault");
  await mkdir(folder, { recursive: true });
  const documents = [];
  for (const [name, content] of [["review.md", source], [`${DEMO}.md`, demo]]) {
    const file = path.join(folder, name);
    await writeFile(file, content, "utf8");
    documents.push({ id: name, path: file, name, content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" });
  }
  if (!record) await copyFile(demoAudio, path.join(folder, `${DEMO}.m4a`));
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: "review.md", folder, documents }), "utf8");
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: language, ...(record ? { OMARKIE_STT: stub } : {}) });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  if (!record) delete env.OMARKIE_STT;
  const media = record ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${speech}`] : [];
  const app = await electron.launch({ args: [process.cwd(), ...headlessArguments, ...media], env });
  const page = await app.firstWindow(), errors = [], requests = [], t = createTranslator(language);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(request.url()));
  await resize(app, page, 1440);
  await page.reload();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  return { app, page, errors, requests, t, folder };
}
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
const rich = page => page.locator(".document-editor:not([hidden]) .rich-document");
// Glass on or off from the Display menu, so the open note stays open.
async function glass(page, t, on) {
  const item = page.getByRole("menuitemcheckbox", { name: t("Glass overlay"), exact: true });
  for (let attempt = 0; attempt < 5 && ((await page.locator(".glass-layer").count()) > 0) !== on; attempt++) {
    if (!(await item.isVisible().catch(() => false))) await page.getByRole("button", { name: t("显示"), exact: true }).click();
    await item.click();
    await page.waitForTimeout(150);
  }
  if (await item.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await expect(page.locator(".glass-layer")).toHaveCount(on ? 1 : 0);
}
const fold = (page, t) => page.getByRole("region", { name: t("Fold view"), exact: true });
async function learning(page, t) {
  await page.getByRole("button", { name: t("显示"), exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: t("Learning mode"), exact: true });
  if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
  else await page.keyboard.press("Escape");
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
}
async function theme(page, t, value) {
  await page.keyboard.press("ControlOrMeta+,");
  const options = page.getByRole("dialog", { name: t("偏好设置"), exact: true });
  await options.getByRole("combobox", { name: t("主题"), exact: true }).selectOption(value);
  await options.getByRole("button", { name: t("完成"), exact: true }).click();
}
async function quickOpen(page, t, name) {
  await page.keyboard.press("Control+P");
  const quick = page.getByRole("dialog", { name: t("快速打开"), exact: true });
  await quick.getByRole("combobox").fill(name);
  await expect(quick.getByRole("option", { selected: true })).toContainText(name);
  await quick.getByRole("combobox").press("Enter");
  await expect(quick).toHaveCount(0);
  await expect(rich(page).getByRole("heading", { level: 1 })).toHaveText(name);
}
async function openFold(page, t) {
  await rich(page).focus();
  await page.keyboard.press("Control+Shift+H");
  await expect(fold(page, t)).toBeVisible();
}
async function stop(page, key, name) {
  await page.keyboard.press(key);
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", name);
}
async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
}
// Resolves with the audio position at the next seek, so a landing is measured where it happened, not a poll later.
// The player is the view's own <audio>; the note's embed renders inside the page as another one.
const nextSeek = page => page.evaluate(() => {
  const audio = document.querySelector(".fold-view > audio");
  window.__seek = new Promise((resolve, reject) => {
    audio.addEventListener("seeked", () => resolve(audio.currentTime), { once: true });
    setTimeout(() => reject(new Error(`no seek (src ${audio.currentSrc}, ready ${audio.readyState}, seekable ${audio.seekable.length && audio.seekable.end(0)})`)), 5_000);
  });
});
const seeked = page => page.evaluate(() => window.__seek);
const audioState = page => page.evaluate(() => { const audio = document.querySelector(".fold-view > audio"); return { paused: audio.paused, time: audio.currentTime }; });

async function grade(file) {
  return sharp(file).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function capture(page, name) {
  await settle(page);
  const shot = path.join(evidence, `${name}.png`);
  await page.locator(".fold-view").screenshot({ path: shot });
  const baseline = path.join(baselines, `${name}.png`);
  if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await mkdir(baselines, { recursive: true }); await copyFile(shot, baseline); return; }
  const [fresh, expected] = await Promise.all([grade(shot), grade(baseline)]);
  assert.equal(fresh.info.height, expected.info.height, `${name}: baseline size differs`);
  let sum = 0, changed = 0;
  for (let index = 0; index < fresh.data.length; index++) { const delta = Math.abs(fresh.data[index] - expected.data[index]); sum += delta; if (delta > 32) changed += 1; }
  const mean = sum / fresh.data.length, fraction = changed / fresh.data.length;
  console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
  assert.ok(mean <= 6 && fraction <= 0.08, `${name}: drifted from baseline (mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%)`);
}
// The demo lecture as Topic cards, and at Key paused on its second paragraph with the follow-along mark.
async function shots(app, page, t, language) {
  for (const width of [1440, 720]) {
    await resize(app, page, width);
    for (const [name, value] of [["light", "omarchy-light"], ["dark", "omarchy-dark"]]) {
      await theme(page, t, value);
      await stop(page, "5", "topic");
      await page.evaluate(() => {
        const topic = document.querySelector(".fold-topic");
        topic.scrollTop = 0;
        topic.querySelector("[data-anchor][tabindex='0']")?.focus({ preventScroll: true });
      });
      await capture(page, `lecture-cards-${language}-${name}-${width}`);
      await stop(page, "3", "key");
      await nextSeek(page);
      await page.evaluate(() => { const audio = document.querySelector(".fold-view > audio"); audio.pause(); audio.currentTime = 4.1; });
      await seeked(page);
      await expect(page.locator(".fold-unit[data-speaking]")).toHaveCount(1);
      await page.evaluate(() => { document.querySelector(".fold-scroller").scrollTop = 0; document.querySelector(".fold-play").focus(); });
      await capture(page, `lecture-key-${language}-${name}-${width}`);
    }
  }
  await theme(page, t, "omarchy-light");
  await resize(app, page, 1440);
}
let { app, page, errors, requests, t, folder } = await launch("en", true);
try {
  await learning(page, t);
  await page.evaluate(() => window.desktop.glassState({ action: "write", visible: true }));
  await page.reload();
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");

  // Record: the lecture tool on a paragraph of the open note, a marked moment, Save.
  await page.locator('.glass-tray [data-glass-tool="lecture"]').click();
  const box = await rich(page).getByText(SOURCE, { exact: true }).boundingBox();
  await page.mouse.click(box.x + 60, box.y + 8);
  await expect(page.locator('[data-voice-pill="recording"]')).toHaveAttribute("data-voice-mode", "lecture");
  await page.waitForTimeout(6_000);
  await page.locator("[data-voice-mark]").click();
  await page.waitForTimeout(6_600);
  await page.locator('[data-voice-stop="save"]').click();
  await expect(page.locator(".glass-notice")).toContainText("Saved", { timeout: 30_000 });
  const saved = (await readdir(folder)).filter(name => /^Lecture .*\.md$/.test(name));
  assert.equal(saved.length, 1, `one lecture note: ${saved}`);
  const title = saved[0].replace(/\.md$/, "");
  const note = await readFile(path.join(folder, saved[0]), "utf8"), audio = await readFile(path.join(folder, `${title}.m4a`));
  assert.ok(note.includes(`![[${title}.m4a]]`), "the note embeds its own audio");
  assert.match(note, /^type: Reference$/m);
  await copyFile(path.join(folder, `${title}.m4a`), demoAudio);
  await copyFile(demoAudio, path.join(folder, `${DEMO}.m4a`));
  const stamps = note.split("\n").map(line => [line, transcriptStamp(line)]).filter(([line, stamp]) => stamp && !line.startsWith("#")).map(([line, stamp]) => ({ ms: stamp.seconds * 1000, text: line.slice(stamp.length) }));
  assert.ok(stamps.length >= 3, note);
  assert.ok(stamps.every(({ text }) => sentences.includes(text)), note);

  // Ground truth: where each burst starts in the saved audio itself, decoded by Chromium from the m4a on disk.
  const decoded = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const buffer = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.buffer);
    return { samples: Array.from(buffer.getChannelData(0)), duration: buffer.duration };
  }, audio.toString("base64"));
  const onsets = burstOnsets(Float32Array.from(decoded.samples), 16_000);
  const nearest = ms => Math.min(...onsets.map(onset => Math.abs(onset - ms)));
  console.log(`stamps ${stamps.map(stamp => stamp.ms.toFixed(0))} ms; audio onsets ${onsets.map(onset => onset.toFixed(0))} ms`);
  for (const stamp of stamps) assert.ok(nearest(stamp.ms) <= LANDING_MS, `stamp ${stamp.ms} ms is ${nearest(stamp.ms)} ms from any spoken onset`);
  // Every sentence with time to be heard before Save has its paragraph.
  for (const onset of onsets.filter(onset => onset < decoded.duration * 1000 - 1_500))
    assert.ok(stamps.some(stamp => Math.abs(stamp.ms - onset) <= LANDING_MS), `the sentence at ${onset} ms has no paragraph`);

  // Fold: Topic lines carry their second; a click lands at Key and plays from it.
  await glass(page, t, false);
  await quickOpen(page, t, title);
  await openFold(page, t);
  await stop(page, "5", "topic");
  await expect(page.locator(".fold-topic-hint")).toContainText("Lines with a time play the lecture from that second");
  const lines = page.locator(".fold-topic-line[data-time]");
  await expect(lines.first()).toBeVisible();
  assert.equal(await page.locator(".fold-topic [data-raw]").count(), 0, "the audio embed is the player, not a chip");
  const line = lines.last(), time = Number(await line.getAttribute("data-time")), unit = await line.getAttribute("data-anchor");
  await expect(line.locator(".fold-time")).toContainText(/^▶ \d\d:\d\d$/);
  await nextSeek(page);
  await watchWork(page);
  await line.click();
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", "key");
  const landed = await seeked(page);
  await page.waitForTimeout(600);
  const { longTasks } = await readWork(page);
  const longest = longTasks.length ? Math.max(...longTasks) : 0;
  console.log(`card click to Key and play: ${longest ? `longest task ${longest.toFixed(0)} ms` : "no long task (none reached 50 ms)"}`);
  assert.ok(longest <= (stableHost() ? 50 : 500), `card click: a ${longest.toFixed(0)} ms long task`);
  console.log(`card at ${time}s landed at ${landed.toFixed(3)}s; spoken onset ${nearest(landed * 1000).toFixed(0)} ms away`);
  assert.ok(Math.abs(landed - time) <= 0.05, `seeked to ${landed}, card says ${time}`);
  assert.ok(nearest(landed * 1000) <= LANDING_MS, `landing is ${nearest(landed * 1000)} ms from the spoken sentence`);
  await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.unit)).toBe(unit);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await expect(page.locator(".fold-unit[data-speaking]")).toHaveAttribute("data-unit", unit);

  // The player: Tab from the level slider, Space pauses, Enter plays again.
  await page.locator(".fold-track").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".fold-play")).toBeFocused();
  await expect(page.locator(".fold-play")).toHaveAttribute("aria-label", /^Pause lecture, \d\d:\d\d$/);
  await page.keyboard.press("Space");
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await expect(page.locator(".fold-play")).toHaveAttribute("aria-label", /^Play lecture/);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);

  // Keyboard path to a card: Topic from the page, Home, arrow to the next card, Enter plays from that card's second.
  await page.locator(".fold-document").focus();
  await stop(page, "5", "topic");
  const cards = page.locator(".fold-card[data-time]");
  await expect(page.locator(".fold-card:focus")).toHaveCount(1);
  await page.keyboard.press("Home");
  await expect(cards.first()).toBeFocused();
  const second = Number(await cards.nth(1).getAttribute("data-time"));
  await nextSeek(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", "key");
  assert.ok(Math.abs(await seeked(page) - second) <= 0.05, "Enter on a card plays from its second");
  await page.keyboard.press("Escape");
  await expect(fold(page, t)).toHaveCount(0);

  // The Glass timeline reads the same note: one transcript cue per paragraph, across the section headings.
  await glass(page, t, true);
  await page.locator('[data-glass-tool="timeline"]').click();
  await expect(page.locator(".glass-timeline")).toBeVisible();
  await expect.poll(() => page.locator(".glass-timeline-transcript button").count()).toBe(stamps.length);
  await glass(page, t, false);

  // Screenshots: the demo lecture, English.
  await quickOpen(page, t, DEMO);
  await openFold(page, t);
  await expect(page.locator(".fold-play")).toBeVisible();
  await shots(app, page, t, "en");
  assert.deepEqual(errors, []);
  const outside = requests.filter(url => /^(?:https?|wss?):/i.test(url));
  assert.deepEqual(outside, [], "no request leaves the machine");
} finally { await app.close(); }

// Spanish: labels, the player and the same views at both widths and themes.
({ app, page, errors, requests, t } = await launch("es", false));
try {
  await learning(page, t);
  await quickOpen(page, t, DEMO);
  await openFold(page, t);
  await stop(page, "5", "topic");
  await expect(page.locator(".fold-topic-hint")).toContainText("Las líneas con hora reproducen la clase desde ese segundo");
  await expect(page.locator(".fold-play")).toHaveAttribute("aria-label", /^Reproducir clase, 00:00$/);
  await shots(app, page, t, "es");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.filter(url => /^(?:https?|wss?):/i.test(url)), []);
} finally { await app.close(); }
console.log("PASS: lecture saved as one note with its m4a; stamps and card landings within 200 ms of the spoken onsets; player and cards by keyboard; Glass timeline cues; no request off the machine; EN/ES light/dark 1440/720.");
