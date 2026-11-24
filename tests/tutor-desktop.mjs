import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-tutor-"));
const vault = path.join(home, "vault"), file = path.join(vault, "map.md");
const paragraph = "Contour lines connect places with the same elevation. Closely spaced contour lines show a steep slope.";
const rewritten = "Contour lines join points of equal elevation. Close spacing means a steep slope.";
const changed = paragraph.replace("steep slope", "sharp incline");
const neighbor = "A saddle is a low point between two summits. Find it by looking for the narrow gap between nested contours.";
const source = `# Reading a contour map\r\n\r\n${paragraph}\r\n\r\n${neighbor}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: "map.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }));
const requests = [];
const firstQuestion = "What does the spacing tell me?", secondQuestion = "What does each line connect?";
const firstAnswer = "**Close spacing** shows a steep slope.", secondAnswer = "Each line connects points of **equal elevation**.";
const holdAnswer = Promise.withResolvers();
const revision = "Rewrite with fewer words.";
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), question = body.messages.at(-1).content;
  requests.push({ url: request.url, body });
  if (question === firstQuestion) await holdAnswer.promise;
  const result = question === firstQuestion ? firstAnswer : question === secondQuestion ? secondAnswer :
    question === revision ? rewritten : "![unexpected](https://example.invalid/image.png)";
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: result } }] }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
let app;
try {
  app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), loaded = [], errors = [];
  page.on("request", request => loaded.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  const button = (root, name) => root.getByRole("button", { name, exact: true });
  const toggle = button(page, "Learning mode"), openTutor = button(page, "Tutor");
  const sheets = page.getByRole("complementary", { name: "Sheets", exact: true });
  const panel = page.getByRole("complementary", { name: "Tutor", exact: true });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const entry = panel.getByRole("textbox", { name: "Ask one question about this text" });
  const send = button(panel, "Send question"), propose = button(panel, "Propose edit");
  const reply = panel.getByRole("region", { name: "Tutor answer", exact: true });
  const diff = panel.getByRole("region", { name: "Edit proposal", exact: true });
  const journal = path.join(vault, ".omarkie", "store.jsonl");
  const rows = async () => (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line).entry);
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function askAbout(text) {
    await rich.getByText(text, { exact: true }).selectText();
    await page.keyboard.press("Alt+Enter");
    await button(page.getByRole("group", { name: "Selection actions" }), "Ask Tutor").click();
    await expect(panel.getByText(text, { exact: true }).first()).toBeVisible();
  }
  async function screenshot(name, width) {
    if (qa) await page.screenshot({ path: path.join(qa, `learning-tutor-${name}-${width}.png`) });
  }
  async function bothWidths(name) {
    await expect(sheets).toBeVisible();
    const [left, center, right] = await Promise.all([sheets.boundingBox(), rich.boundingBox(), panel.boundingBox()]);
    assert.ok(left.x + left.width <= center.x && center.x + center.width <= right.x);
    await screenshot(name, 1440);
    await resize(720);
    await expect(sheets).toBeHidden();
    await expect(panel).toBeInViewport();
    const [narrowCenter, narrowRight] = await Promise.all([rich.boundingBox(), panel.boundingBox()]);
    assert.ok(narrowCenter.width > 0 && narrowCenter.x + narrowCenter.width <= narrowRight.x);
    await screenshot(name, 720);
    await resize(1440);
  }
  await resize(1440);
  await expect(rich.getByRole("heading", { name: "Reading a contour map" })).toBeVisible();
  await expect(openTutor).toHaveCount(0);
  assert.ok(!loaded.some(url => /LearningMode-|PayloadPanel-|payload-controls/.test(url)));
  await button(page, "More actions").click();
  const autosave = page.getByRole("menuitemcheckbox", { name: "Auto-save existing files", exact: true });
  await expect(autosave).toHaveAttribute("aria-checked", "true");
  await autosave.click();
  await expect(autosave).toHaveAttribute("aria-checked", "false");
  await autosave.press("Escape");
  await toggle.click();
  await askAbout(paragraph);
  await button(panel, "Payload").click();
  await expect(send).toBeDisabled();
  await button(panel, "Preferences").click();
  await preferences.getByLabel("Enable Payload").check();
  await preferences.getByLabel("Payload model").fill("fixture");
  await preferences.getByLabel("Payload base URL").fill("https://inference.example.invalid/v1");
  if (qa) await preferences.getByRole("combobox", { name: "Theme", exact: true }).selectOption("omarchy-dark");
  await button(preferences, "Done").click();
  await entry.fill(firstQuestion);
  await expect(send).toBeDisabled();
  await expect(propose).toBeDisabled();
  await button(panel, "Preferences").click();
  await preferences.getByLabel("Allow Payload requests to https://inference.example.invalid").check();
  await button(preferences, "Done").click();
  await expect(send).toBeEnabled();
  await expect(panel).toContainText("Sends this paragraph and your request to https://inference.example.invalid.");
  await page.keyboard.press("ControlOrMeta+,");
  await preferences.getByLabel("Payload base URL").fill(`${origin}/v1`);
  await button(preferences, "Done").click();
  await expect(panel).toContainText(`Sends this paragraph and your request to ${origin}.`);
  await expect(panel).toContainText("Do not send identifiable medical data.");
  assert.equal(requests.length, 0);
  await assert.rejects(stat(journal), { code: "ENOENT" });

  await send.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(entry).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(propose).toBeDisabled();
  holdAnswer.resolve();
  await expect(reply.locator("strong")).toHaveText("Close spacing");
  await assert.rejects(stat(journal), { code: "ENOENT" });
  await button(reply, "Stick on paragraph").click();
  await expect(button(reply, "Pinned to paragraph")).toBeDisabled();
  const [pinned] = await rows();
  assert.equal(pinned.document, "map.md");
  assert.equal(pinned.anchor.line, 3);
  assert.equal(pinned.anchor.hash.length, 64);
  assert.equal(pinned.body, firstAnswer);
  assert.equal(pinned.question, firstQuestion);
  assert.equal(pinned.sheet, "tutor-answers");
  await bothWidths("answer");
  await entry.fill(secondQuestion);
  await send.click();
  await expect(reply.locator("strong")).toHaveText("equal elevation");
  await expect(reply).not.toContainText(firstQuestion);
  for (const [index, question] of [firstQuestion, secondQuestion].entries()) {
    assert.equal(requests[index].url, "/v1/chat/completions");
    assert.deepEqual(requests[index].body.messages.slice(1), [{ role: "user", content: paragraph }, { role: "user", content: question }]);
  }
  assert.equal(await readFile(file, "utf8"), source);

  await entry.fill("Return an image instead.");
  await propose.click();
  await expect(panel.getByRole("alert")).toContainText("did not return a safe paragraph");
  await expect(diff).toHaveCount(0);
  assert.equal((await rows()).length, 1);
  await entry.fill(revision);
  await propose.click();
  await expect(diff.locator("del")).toHaveText(paragraph);
  await expect(diff.locator("ins")).toHaveText(rewritten);
  assert.equal(await readFile(file, "utf8"), source);
  await expect(rich.getByText(paragraph, { exact: true })).toBeVisible();
  assert.match(requests.at(-1).body.messages[0].content, /^Rewrite only the supplied paragraph/);
  await bothWidths("proposal");

  await expect(rich).toHaveAttribute("contenteditable", "false");
  await rich.getByText(paragraph, { exact: true }).selectText();
  await page.keyboard.insertText(changed);
  await expect(rich.getByText(paragraph, { exact: true })).toBeVisible();
  await toggle.click();
  await expect(rich).toHaveAttribute("contenteditable", "true");
  await rich.getByText(paragraph, { exact: true }).selectText();
  await page.keyboard.insertText(changed);
  await expect(rich.getByText(changed, { exact: true })).toBeVisible();
  await toggle.click();
  await askAbout(changed);
  await button(panel, "Payload").click();
  await expect(diff).toBeVisible();
  await button(diff, "Accept into Markdown").click();
  await expect(panel.getByRole("alert")).toHaveText("The paragraph changed. Ask for a new proposal.");
  await expect(rich.getByText(changed, { exact: true })).toBeVisible();
  assert.equal(await readFile(file, "utf8"), source);
  await button(diff, "Reject").click();
  await expect(diff).toHaveCount(0);

  await entry.fill(revision);
  await propose.click();
  await expect(diff.locator("ins")).toHaveText(rewritten);
  assert.equal(await readFile(file, "utf8"), source);
  await button(diff, "Accept into Markdown").click();
  await expect(rich.getByText(rewritten, { exact: true })).toBeVisible();
  await expect(diff).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(source.replace(paragraph, rewritten));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rich.getByText(changed, { exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(source.replace(paragraph, changed));
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded.filter(url => /^https?:/.test(url)), []);
  console.log("PASS: Tutor reuses Payload consent and stateless requests, pins anchored answers, rejects unsafe/stale edits, and accepts a one-undo exact Markdown patch");
} finally {
  holdAnswer.resolve();
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
