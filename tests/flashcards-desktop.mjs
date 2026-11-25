import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-flashcards-"));
const vault = path.join(home, "vault"), file = path.join(vault, "facts.md"), sidecar = path.join(vault, ".omarkie");
const source = "# Facts\r\n\r\n" + ["helium", "neon", "argon", "krypton", "xenon", "radon"]
  .map((element, index) => `Noble gas ${index + 1}: ==${element}==.\r\n\r\n`).join("") + "Select this passage to make one more card.\r\n";
await mkdir(vault);
await writeFile(file, source);
const record = { id: "fixture", path: file, name: "facts.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }));
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), requests = [], errors = [];
  page.on("request", request => requests.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const rail = page.getByRole("complementary", { name: "Layers", exact: true })
    .or(page.getByRole("group", { name: "Layers", exact: true }));
  const cards = page.getByRole("complementary", { name: "Study cards", exact: true });
  const study = page.getByRole("complementary", { name: "Test me", exact: true });
  const reveal = study.getByRole("button", { name: "Show answer", exact: true });
  const closeCards = cards.getByRole("button", { name: "Close Study cards", exact: true });
  const journal = () => readFile(path.join(sidecar, "store.jsonl"), "utf8").then(text => text.trim().split("\n").map(row => JSON.parse(row).entry));
  async function openRail() {
    await page.getByRole("button", { name: "Learning mode", exact: true }).click();
    await expect(rail).toBeVisible();
  }
  async function openCards() {
    await rail.getByRole("button", { name: "Study cards", exact: true }).click();
    await expect(cards.getByText(/Cards in this note:/)).toBeVisible();
  }
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Facts" })).toBeVisible();
  await openRail();
  assert.ok(!requests.some(url => /\/Flashcards-/.test(url)), "Learning mode must not load the flashcard implementation until requested");
  const excerpt = "Select this passage to make one more card.";
  await rich.getByText(excerpt, { exact: true }).selectText();
  await page.keyboard.press("Alt+Enter");
  await page.getByRole("group", { name: "Selection actions", exact: true }).getByRole("button", { name: "Make it a card", exact: true }).click();
  await expect(cards.getByRole("textbox", { name: "Answer", exact: true })).toHaveValue(excerpt);
  assert.ok(requests.some(url => /\/Flashcards-/.test(url)));
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  await cards.getByRole("button", { name: "Save selected cards", exact: true }).click();
  await expect(cards).toContainText("Cards in this note: 1 / 10");
  await cards.getByRole("button", { name: "Make cards from highlights and notes", exact: true }).click();
  await expect(cards.getByRole("textbox", { name: "Answer", exact: true })).toHaveCount(6);
  await expect(cards.getByRole("textbox", { name: "Answer", exact: true }).first()).toHaveValue("helium");
  await cards.getByRole("checkbox", { name: "Card 6", exact: true }).uncheck();
  await cards.getByRole("button", { name: "Save selected cards", exact: true }).click();
  await expect(cards).toContainText("Cards in this note: 6 / 10");
  const saved = await journal();
  assert.deepEqual(saved.map(entry => entry.back), [excerpt, "helium", "neon", "argon", "krypton", "xenon"]);
  assert.ok(saved.every(entry => entry.document === "facts.md" && entry.anchor.hash));

  await cards.getByRole("button", { name: "Test me", exact: true }).click();
  await expect(reveal).toBeFocused();
  await expect(study).not.toContainText(saved[0].back);
  await page.keyboard.press("Enter");
  await expect(study).toContainText(saved[0].back);
  await study.getByRole("button", { name: /No recall/ }).click();
  await expect(study).toContainText("Rated: 1 · Remaining: 6");
  for (let n = 0; n < saved.length; n++) {
    await reveal.click();
    await study.getByRole("button", { name: /Perfect recall/ }).click();
  }
  await expect(study).toContainText("Review complete.");
  const answers = (await journal()).filter(entry => entry.type === "answer");
  assert.deepEqual(answers.map(entry => entry.rating), [0, 5, 5, 5, 5, 5, 5]);
  assert.equal(answers.at(-1).cardId, answers[0].cardId);
  assert.equal(await readFile(file, "utf8"), source);
  await study.getByRole("button", { name: "Back to cards", exact: true }).click();
  await closeCards.click();
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Facts" })).toBeVisible();
  await expect(rail).toBeVisible();
  await openCards();
  await cards.getByRole("button", { name: "Test me", exact: true }).click();
  await expect(study).toContainText("No new or due cards in this vault.");
  assert.deepEqual(errors, []);
  console.log("PASS: lazy flashcards, selection and highlight drafts, recall loop, durable ratings, unchanged Markdown");
} finally { await app.close(); }
