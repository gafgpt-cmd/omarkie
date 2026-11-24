import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { _electron as playwright, expect } from "playwright/test";
import electron from "electron";
import { endpoint } from "../electron/tutor-transport.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

if (process.platform === "win32") process.exit(0);
const temp = await realpath(await mkdtemp(path.join(tmpdir(), "omarkie-live-test-")));
const home = path.join(temp, "home"), vault = path.join(temp, "vault"), other = path.join(temp, "other"), doc = "map.md";
const file = path.join(vault, doc), after = path.join(temp, "rewrite.txt"), qa = process.env.OMARKIE_QA_DIR;
const paragraph = "Closely spaced contour lines indicate a steep slope.";
const neighbor = "A saddle is a low point between two summits.";
const source = `# Reading a **contour map**\r\n\r\n${paragraph}\r\n\r\n${neighbor}\r\n`;
const offlineNote = 'Offline note: "Steep compared with what?"';
const offlineEdit = "Contour lines close together indicate a steep slope.";
const liveNote = "Read the contour interval before estimating a slope.";
const liveEdit = "A saddle is the low point between two peaks.";
const answer = "The same elevation change occurs across a **shorter horizontal distance**.";
for (const folder of [home, vault, other]) await mkdir(folder);
await writeFile(file, source);
await writeFile(path.join(other, doc), source);
const fixtures = { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
  content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" }] };
await writeFile(path.join(home, "session.json"), JSON.stringify(fixtures));
const transcript = [], entry = path.resolve("electron/omarkie-axi.mjs");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMARKIE_LANGUAGE: "en" };
async function run(args, folder = vault) {
  let stdout, status = 0;
  try { ({ stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: folder, env, timeout: 12_000 })); }
  catch (error) { if (typeof error.code !== "number" || !error.stdout) throw error; stdout = error.stdout; status = error.code; }
  transcript.push(`$ omarkie-axi ${args.map(value => value.startsWith(temp) ? path.basename(value) : JSON.stringify(value)).join(" ")} [${path.basename(folder)}]\n${stdout.trim()}\n`);
  return { status, output: stdout ? decode(stdout) : null };
}
async function success(...args) { const result = await run(args); assert.equal(result.status, 0, JSON.stringify(result.output)); return result.output; }
async function guarded(socket) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket, () => client.write('{"op":"home","token":"wrong"}\n'));
    let output = "";
    client.setEncoding("utf8").on("data", data => { output += data; }).on("end", () => resolve(JSON.parse(output))).on("error", reject);
    client.setTimeout(2000, () => client.destroy(new Error("Tutor authentication did not respond")));
  });
}
const blocks = (await success("doc", "view", doc, "--blocks")).blocks.filter(block => block.kind === "paragraph_open");
await success("scrap", "add", "--doc", doc, "--block", blocks[0].hash, "--text", offlineNote);
await writeFile(after, offlineEdit + "\n");
await success("propose", "--doc", doc, "--block", blocks[0].hash, "--after-file", after, "--reason", "Clarify spacing");
assert.equal((await success("proposals")).count, 1);
assert.deepEqual(await readFile(file), Buffer.from(source));
const typo = await run(["poll", "--wat"]);
assert.equal(typo.status, 2);
assert.equal(typo.output.code, "VALIDATION_ERROR");
await success("skill", "--check");
await success("setup", "hooks");
assert.ok((await success("setup", "hooks")).hooks.every(hook => hook.status === "unchanged"));

const launchEnv = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete launchEnv.OMARKIE_DEV_URL; delete launchEnv.ELECTRON_RUN_AS_NODE;
const app = await playwright.launch({ args: [process.cwd(), ...headlessArguments], env: launchEnv });
try {
  const page = await app.firstWindow(), network = [], errors = [];
  page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  const button = (root, name) => root.getByRole("button", { name, exact: true });
  const toggle = button(page, "Learning mode"), panel = page.getByRole("complementary", { name: "Tutor" });
  const newQuestion = panel.getByRole("textbox", { name: "Ask one question about this text" });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const place = endpoint(vault);
  const socketPresent = () => lstat(place.socket).then(stat => stat.isSocket(), () => false);
  async function snapshot(name) { if (qa) await page.screenshot({ path: path.join(qa, `learning-axi-${name}-1440.png`) }); }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1440, 900]);
  await expect(rich.getByText(paragraph, { exact: true })).toBeVisible();
  assert.equal(await socketPresent(), false);
  await toggle.click();
  await expect(page.getByRole("button", { name: `Fold or unfold: ${offlineNote}` })).toBeVisible();
  await rich.getByText(paragraph, { exact: true }).selectText();
  await page.keyboard.press("Alt+Enter");
  await button(page.getByRole("group", { name: "Selection actions" }), "Ask Tutor").click();
  await expect(panel.getByRole("button", { name: "Local agent", pressed: true })).toBeVisible();
  await expect(panel.getByText(offlineEdit, { exact: true })).toBeVisible();
  await expect(panel.getByText("Clarify spacing", { exact: true })).toBeVisible();
  assert.equal(await socketPresent(), false);
  await snapshot("offline-scrap-and-proposal");

  const question = "Why does the spacing show steepness?";
  await newQuestion.fill(question);
  await button(panel, "Send question").click();
  await expect(panel.getByRole("status")).toHaveText("Queued for a local agent");
  await expect.poll(socketPresent).toBe(true);
  assert.equal((await lstat(place.discovery)).mode & 0o777, 0o600);
  assert.equal((await lstat(place.socket)).mode & 0o777, 0o600);
  assert.deepEqual(await guarded(place.socket), { error: "Unauthorized Tutor bridge request." });
  assert.deepEqual((await run(["poll"], other)).output, { app: "closed", asks: [] });
  const started = await success();
  assert.equal(started.asks[0].block, blocks[0].hash);
  const [id] = started.asks.map(item => item.id);
  const note = await success("ask", "view", id, "--full");
  assert.equal(note.ask.paragraph, paragraph);
  const { stdout: hook } = await promisify(execFile)(electron, [entry, "context", "--agent", "claude"], { cwd: vault, env, timeout: 3000 });
  const extra = JSON.parse(hook).hookSpecificOutput.additionalContext;
  assert.equal(decode(extra).tutorAsks, 1);
  assert.ok(!extra.includes(question));
  await snapshot("queued");

  const polled = await success("poll", "--doc", doc, "--owner", "Test agent");
  assert.equal(polled.ask.id, id);
  assert.equal(polled.ask.question, question);
  assert.equal(polled.ask.status, "seen");
  await expect(panel.getByRole("status")).toHaveText("Agent received the question");
  await success("status", id, "working");
  await expect(panel.getByRole("status")).toHaveText("Agent is working");
  assert.equal((await run(["reply", id, "--text", "Wrong vault"], other)).status, 1);
  await success("reply", id, "--text", answer);
  await expect(panel.getByRole("region", { name: "Tutor answer" })).toContainText("shorter horizontal distance");
  await expect(panel.getByRole("status")).toHaveText("Agent replied");
  await success("status", id, "done");

  await success("scrap", "add", "--doc", doc, "--block", blocks[1].hash, "--text", liveNote);
  await writeFile(after, liveEdit);
  await success("propose", "--doc", doc, "--block", blocks[1].hash, "--after-file", after);
  await expect(page.getByRole("button", { name: `Fold or unfold: ${liveNote}` })).toBeVisible();
  await expect(panel.getByText(liveEdit, { exact: true })).toBeVisible();
  const listener = run(["poll", "--wait", "--owner", "First listener"]);
  await expect(panel.getByText("Connected: First listener")).toBeVisible();
  const busy = await run(["poll", "--owner", "Second listener"]);
  assert.equal(busy.status, 1);
  assert.match(busy.output.error, /LISTENER_ACTIVE/);
  const takeover = run(["poll", "--wait", "--takeover", "--owner", "Second listener"]);
  await expect(panel.getByText("Connected: Second listener")).toBeVisible();
  assert.equal((await listener).output.error, "LISTENER_REPLACED");
  await newQuestion.fill("What is one clue?");
  await button(panel, "Send question").click();
  const followup = await takeover;
  assert.equal(followup.output.ask.question, "What is one clue?");
  await success("reply", followup.output.ask.id, "--text", answer);
  await expect(panel.getByRole("region", { name: "Tutor answer" })).toContainText("shorter horizontal distance");
  await snapshot("reply-and-proposals");
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(socketPresent).toBe(false);
  assert.equal(await lstat(place.discovery).then(() => true, () => false), false);
  assert.deepEqual(await success("poll"), { app: "closed", asks: [] });
  assert.deepEqual(await readFile(file), Buffer.from(source));
  assert.deepEqual(network, []);
  assert.deepEqual(errors, []);
  console.log("Tutor AXI: offline journal, local authenticated asks, takeover, receipts, vault isolation, no Markdown writes or HTTP requests.");
} finally {
  await app.close();
  if (qa) await writeFile(path.join(qa, "learning-axi-transcript.txt"), transcript.join("\n"));
}
