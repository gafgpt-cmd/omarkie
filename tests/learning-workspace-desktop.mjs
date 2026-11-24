import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { readingStore } from "../electron/reading-store.mjs";
import { requestBridge } from "../electron/tutor-transport.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

if (process.platform === "win32") process.exit(0);
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-learning-workspace-")));
const vault = path.join(home, "vault"), file = path.join(vault, "contours.md"), other = path.join(vault, "river.md");
const paragraph = "Contour lines connect equal elevations. Close lines indicate steep slopes.";
const neighbor = "The saddle is the lowest point between the two peaks.";
const source = `# Reading a topographic map\n\n${paragraph}\n\n${neighbor}\n`;
const secondary = "# Reading rivers\n\nContour lines bend upstream where a river crosses them.\n";
const record = { id: "fixture", name: "contours.md", path: file, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await mkdir(vault);
const legacyIndex = path.join(home, "learning-index");
await mkdir(legacyIndex);
await writeFile(path.join(legacyIndex, "legacy.sqlite"), "Legacy search excerpt");
await writeFile(file, source); await writeFile(other, secondary);
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }));
await readingStore({ folder: vault, require: () => ({ path: other }) }, "other", { action: "put", item: {
  id: "river-note", type: "scrap", kind: "note", sheet: "notes", body: "Méander geometry and upstream flow.", folded: true, stackOf: null, anchor: null,
} });
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const state = path.join(env.XDG_STATE_HOME || path.join(home, "state"), "omarchy", "current");
const theme = path.join(state, "theme");
const palette = accent => `background = "#202531"\nforeground = "#d9e0ee"\naccent = "${accent}"\ngreen = "#93c98a"\nred = "#d38b8f"\nyellow = "#e0c184"\n`;
await mkdir(theme, { recursive: true }); await writeFile(path.join(theme, "colors.toml"), palette("#89b7ee"));
const app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow();
  const error = []; page.on("pageerror", err => error.push(err.message));
  const button = (where, name) => where.getByRole("button", { name, exact: true });
  const sidebar = page.locator(".sidebar"), rail = sidebar.getByRole("complementary", { name: "Sheets" });
  const panel = page.getByRole("complementary", { name: "Tutor" }), verbs = panel.getByRole("group", { name: "Tutor actions" });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const reply = panel.getByRole("region", { name: "Tutor answer" });
  const selection = page.getByRole("group", { name: "Selection actions" });
  const look = page.getByRole("group", { name: "Sheets", exact: true });
  const tutor = button(page, "Tutor"), toggle = button(page, "Learning mode"), toggleSidebar = button(page, "Toggle Sidebar");
  const qa = process.env.OMARKIE_QA_DIR;
  async function screenshot(name) { if (qa) await page.screenshot({ path: path.join(qa, `learning-workspace-${name}.png`) }); }
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function choose(key) {
    await rich.getByText(paragraph, { exact: true }).selectText();
    await page.keyboard.press("Alt+Enter"); await expect(selection).toBeVisible(); await page.keyboard.press(key);
  }
  async function respond(verb, text, sample) {
    await expect(panel.getByRole("status")).toHaveText("Queued for a local agent");
    await expect.poll(() => requestBridge(vault, { op: "home" }, 1200).then(value => value?.asks[0]?.verb)).toBe(verb);
    const { ask } = await requestBridge(vault, { op: "poll", owner: "Fixture tutor" }, 3_000);
    assert.equal(ask.verb, verb); assert.equal(ask.paragraph, paragraph);
    if (sample) assert.ok(ask.question.includes(sample));
    assert.equal((await requestBridge(vault, { op: "reply", id: ask.id, text }, 3_000)).status, "done");
  }
  await resize(1440);
  await expect(rich.getByText(paragraph, { exact: true })).toBeVisible();
  await toggle.press("Enter");
  await expect(rail).toBeVisible();
  assert.equal(await rail.evaluate(el => !!el.closest(".sidebar")), true);
  await page.keyboard.press("ControlOrMeta+,");
  const options = page.getByRole("dialog", { name: "Preferences" });
  if (process.platform === "linux") {
    await options.getByRole("combobox", { name: "Theme", exact: true }).selectOption("omarchy");
    await expect.poll(() => button(rail, "Notes").evaluate(el => getComputedStyle(el).getPropertyValue("--accent").trim())).toBe("#89b7ee");
    await writeFile(path.join(theme, "colors.toml"), palette("#b5a1e5"));
    await writeFile(path.join(state, "theme.name"), "fixture2\n");
    await expect.poll(() => button(rail, "Notes").evaluate(el => getComputedStyle(el).getPropertyValue("--accent").trim())).toBe("#b5a1e5");
  }
  await button(options, "Done").press("Enter");
  const confidence = (name, where = rail) => where.getByRole("button", { name: `Paragraph 3: ${name}`, exact: true });
  await confidence("Not rated").press("Enter");
  await expect(confidence("Lost")).toBeVisible();
  await choose("d");
  await selection.getByRole("textbox", { name: "Doubt" }).fill("How steep is the slope?");
  await selection.getByRole("textbox", { name: "Doubt" }).press("Enter");
  await expect(page.getByRole("article", { name: "How steep is the slope?" })).toBeVisible();

  await choose("a");
  const ask = panel.getByRole("textbox", { name: "Ask one question about this text" });
  await ask.fill("What do the lines connect?"); await ask.press("Enter");
  await respond("answer", "Each line joins places at the same height.", "lines connect");
  await expect(reply).toContainText("same height");
  await button(reply, "Still lost").press("Enter");
  await expect(button(verbs, "Simplify")).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("textbox", { name: "Instructions (optional)" }).press("Enter");
  await respond("simplify", "Think of a line drawn level around a hill.", "same height");
  await expect(reply).toContainText("drawn level");
  await button(reply, "Stick on paragraph").press("Enter");
  await expect(button(reply, "Pinned to paragraph")).toBeDisabled();
  const journal = path.join(vault, ".omarkie", "store.jsonl");
  const rows = async () => (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line).entry);
  const history = await rows();
  assert.equal(history.find(item => item?.body?.includes("drawn level")).stackOf, history.find(item => item?.body?.includes("same height")).id);

  await choose("w");
  const correction = selection.getByRole("textbox", { name: "Your correction" });
  await correction.fill("Mention that the contour interval stays constant on a map."); await correction.press("ControlOrMeta+Enter");
  const check = panel.getByRole("textbox", { name: "Your correction" });
  await expect(check).toHaveValue(/contour interval/); await check.press("Enter");
  await respond("check", JSON.stringify({ feedback: "The interval sets the height difference.", replacement: "Contour lines join equal elevations. Their interval is fixed on a map." }), "interval");
  await expect(reply).toContainText("sets the height difference");
  await expect(panel.getByRole("region", { name: "Edit proposal" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Correction on the sheet" })).toContainText("stays constant");

  await choose("e");
  const explain = panel.getByRole("textbox", { name: "Your explanation" });
  await explain.fill("Close contours mean a large rise over a short run."); await explain.press("Enter");
  await respond("explain", "Good. Add that compared contours share an interval.", "short run");
  await expect(reply).toContainText("short run"); await button(reply, "Stick on paragraph").press("Enter");
  await expect(button(reply, "Pinned to paragraph")).toBeDisabled();
  await choose("q");
  await panel.getByRole("textbox", { name: "Instructions (optional)" }).press("Enter");
  await respond("quiz", "What does close spacing imply?");
  await expect(reply).toContainText("spacing imply"); await button(reply, "Answer quiz").press("Enter");
  const grade = panel.getByRole("textbox", { name: "Your answer" });
  await grade.fill("A steep slope."); await grade.press("Enter");
  await respond("grade", JSON.stringify({ feedback: "Correct: the slope is steep.", confidence: 3 }), "spacing imply");
  await expect(confidence("Solid")).toBeVisible();
  await expect(reply).toContainText("Correct: the slope is steep.");
  await screenshot("1440");
  await button(verbs, "Make it a card").press("Enter");
  const cards = page.getByRole("complementary", { name: "Study cards" });
  await expect(cards.getByRole("textbox", { name: "Answer", exact: true })).toHaveValue("Correct: the slope is steep.");
  await button(cards, "Save selected cards").press("Enter");
  await expect.poll(async () => (await rows()).filter(item => item?.type === "card").length).toBe(1);
  await cards.press("Escape");

  await choose("p");
  const revision = panel.getByRole("textbox", { name: "Instructions (optional)" });
  await revision.fill("Explain steepness with fewer words."); await revision.press("Enter");
  await respond("propose", "Close contour lines mark steep ground.", "fewer words");
  await expect(panel.getByText("Close contour lines mark steep ground.", { exact: true })).toBeVisible();
  await panel.press("Escape");

  await resize(720);
  await expect(look).toBeVisible(); await expect(rail).toBeHidden();
  await expect(confidence("Solid", look)).toBeVisible();
  await tutor.press("Enter"); await expect(panel).toBeVisible(); await screenshot("720-tutor");
  await toggleSidebar.press("Enter"); await expect(rail).toBeVisible(); await expect(panel).toHaveCount(0);
  assert.ok((await rail.boundingBox()).x + (await rail.boundingBox()).width <= (await rich.boundingBox()).x);
  await screenshot("720-sheets");
  const doubts = button(rail, "Doubts");
  await doubts.click();
  await expect(doubts).toHaveAttribute("aria-pressed", "false");
  await button(rail, "Active layer: Doubts").click();
  await expect(doubts).toHaveAttribute("aria-pressed", "true");
  await rich.getByText(paragraph, { exact: true }).selectText();
  await page.keyboard.press("Alt+Enter");
  await expect(button(selection, "Doubt")).toBeFocused();
  await button(selection, "Note").click();
  const routedNote = selection.getByRole("textbox", { name: "Note" });
  await routedNote.fill("A note on the chosen sheet.");
  await routedNote.press("Enter");
  await expect.poll(async () => (await rows()).find(item => item?.body === "A note on the chosen sheet.")?.sheet).toBe("doubts");
  await tutor.press("Enter"); await expect(panel).toBeVisible(); await expect(rail).toBeHidden();
  await panel.press("Escape"); await expect(panel).toHaveCount(0);
  await button(look, "Search scraps").press("Enter");
  const search = page.getByRole("dialog", { name: "Search scraps" }), query = search.getByRole("searchbox");
  await query.fill('"meander" OR'); await query.press("Enter"); await expect(search.getByRole("status")).toHaveText("No scraps found.");
  await query.fill("meander upstream"); await query.press("Enter");
  const hit = search.getByRole("button", { name: /river\.md.*Méander geometry/ });
  await expect(hit).toBeVisible();
  await assert.rejects(stat(legacyIndex), { code: "ENOENT" });
  await readingStore({ folder: vault, require: () => ({ path: other }) }, "other", { action: "put", item: {
    id: "river-note", type: "scrap", kind: "note", sheet: "notes", body: "River bends and upstream flow.", folded: true, stackOf: null, anchor: null,
  } });
  await query.press("Enter"); await expect(search.getByRole("status")).toHaveText("No scraps found.");
  await query.fill("river bends"); await query.press("Enter");
  await search.getByRole("button", { name: /river\.md.*River bends/ }).press("Enter");
  await expect(rich.getByRole("heading", { name: "Reading rivers" })).toBeVisible();
  assert.equal(await readFile(file, "utf8"), source); assert.equal(await readFile(other, "utf8"), secondary);
  assert.deepEqual(error, []);
  console.log("PASS: Sheets at 1440 and 720, Omarchy repaint, keyboard Tutor verbs, stored confidence, flashcards, and rebuilt vault search.");
} finally { await app.close(); }
