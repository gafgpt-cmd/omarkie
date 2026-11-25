import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Synthetic dosing only; no real protocol, drug or dose table is involved.
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-g16-"));
const vault = path.join(home, "vault"), doc = "protocol.md";
const heading = "Synthetic protocol";
const firstLine = "Weight-based dosing paragraph for the calculator.";
const secondLine = "Allergy and stability paragraph for the decision flow.";
const source = `# ${heading}\n\n${firstLine}\n\n${secondLine}\n\nA third paragraph gives the margin room.\n`;
const flow = {
  question: "Is the patient stable?",
  choices: [
    { label: "Yes", next: { result: "Follow the synthetic protocol." } },
    { label: "No", next: {
      question: "Allergic to the synthetic drug?",
      choices: [
        { label: "Yes", next: { result: "Use the synthetic alternative." } },
        { label: "No", next: { result: "Give the synthetic loading dose." } },
      ],
    } },
  ],
};
const flowText = [
  "Question: Is the patient stable?", "- Yes", "  Result: Follow the synthetic protocol.",
  "- No", "  Question: Allergic to the synthetic drug?", "  - Yes", "    Result: Use the synthetic alternative.",
  "  - No", "    Result: Give the synthetic loading dose.",
].join("\n");
await mkdir(vault);
await writeFile(path.join(vault, doc), source, "utf8");
const evidence = process.env.OMARKIE_GLASS_G16_SHOTS ?? path.join(home, "screens");
await mkdir(evidence, { recursive: true });

function session(folder, name, content) {
  const file = path.join(folder, name);
  return { version: 1, activeId: "fixture", folder, documents: [{ id: "fixture", path: file, name,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" }] };
}
await writeFile(path.join(home, "session.json"), JSON.stringify(session(vault, doc, source)), "utf8");

const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function boot(data = home, folder = vault, name = doc, text = source, extraEnv = {}) {
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "session.json"), JSON.stringify(session(folder, name, text)), "utf8");
  const env = await isolatedEnvironment({ ...process.env, ...extraEnv, OMARKIE_DATA_DIR: data, OMARKIE_LANGUAGE: "en" });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { app, page, env, errors };
}
async function axiIn(folder, env, ...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: folder, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
  return decode(stdout);
}
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
async function openGlass(page, name = heading) {
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await page.keyboard.press("Escape");
  }
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await rich.click({ position: { x: 4, y: 4 } });
  if (!await page.locator(".glass-layer").count()) await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0);
  return rich;
}
async function openDialog(page, kind) {
  await page.locator('[data-glass-tool="card"]').click();
  const dialog = page.getByRole("dialog", { name: "New card" });
  await expect(dialog).toBeVisible();
  await dialog.locator(`[data-card-new-kind="${kind}"]`).click();
  return dialog;
}
const calcCard = page => page.locator('.glass-card[data-card-kind="calc"]');
const unfold = async (page, card) => {
  if (await card.getAttribute("data-folded") !== "true") return;
  const pill = card.locator("[data-card-pill]");
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect(card).not.toHaveAttribute("data-folded", "true");
};
const flowCard = page => page.locator('.glass-card[data-card-kind="flow"]');

// A. Calculator: create, evaluate, cite, flag a range, reject a unit mismatch.
{
  const { app, page, env, errors } = await boot();
  try {
    await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
    const rich = await openGlass(page);
    await resize(app, page, 1440);
    await rich.locator("p[data-cid]", { hasText: firstLine }).click();
    const dialog = await openDialog(page, "calc");
    await dialog.locator("[data-card-new-title]").fill("Weight dose");
    await dialog.locator("[data-card-new-formula]").fill("dose * weight");
    await dialog.locator("[data-card-new-unit]").fill("mg");
    await dialog.locator("[data-card-new-inputs]").fill("dose | Dose | mg/kg | 0 | 10\nweight | Weight | kg | 0 | 200");
    await dialog.locator("[data-card-new-citation]").fill("Synthetic protocol §4.2");
    await dialog.locator("[data-card-new-submit]").click();
    await expect(dialog).toHaveCount(0);
    const calc = calcCard(page);
    await expect(calc).toHaveCount(1);
    await expect(calc.locator("[data-card-citation]")).toContainText("Synthetic protocol §4.2");
    await calc.locator('[data-card-input="dose"] input').fill("2");
    await calc.locator('[data-card-input="weight"] input').fill("70");
    await expect(calc.locator("[data-card-value]")).toHaveText("140", { timeout: 10_000 });
    await expect(calc.locator("[data-card-result-unit]")).toHaveText("mg");
    await expect(calc.locator("[data-card-precision]")).toContainText("2 dp");
    await expect(calc.locator("[data-card-flag]")).toHaveCount(0);

    // Out of range is flagged in place; the number is not clamped.
    await calc.locator('[data-card-input="weight"] input').fill("240");
    await expect(calc.locator('[data-card-flag="weight"]')).toContainText("above the accepted 0 – 200 kg");
    await expect(calc.locator("[data-card-value]")).toHaveText("480");
    await calc.locator('[data-card-input="weight"] input').fill("70");

    // A mismatched output unit is refused with the unit named.
    await rich.locator("p[data-cid]", { hasText: secondLine }).click();
    const mismatch = await openDialog(page, "calc");
    await mismatch.locator("[data-card-new-title]").fill("Wrong unit");
    await mismatch.locator("[data-card-new-formula]").fill("dose * weight");
    await mismatch.locator("[data-card-new-unit]").fill("mL");
    await mismatch.locator("[data-card-new-inputs]").fill("dose | Dose | mg/kg | 0 | 10\nweight | Weight | kg | 0 | 200");
    await mismatch.locator("[data-card-new-citation]").fill("Synthetic protocol §9");
    await mismatch.locator("[data-card-new-submit]").click();
    await expect(mismatch).toHaveCount(0);
    const wrong = page.locator('.glass-card[data-card-kind="calc"]', { hasText: "Wrong unit" });
    await wrong.locator('[data-card-input="dose"] input').fill("2");
    await wrong.locator('[data-card-input="weight"] input').fill("70");
    await expect(wrong.locator("[data-card-error]")).toContainText("outputs mL", { timeout: 10_000 });
    await wrong.focus();
    await page.keyboard.press("Delete");
    await expect(wrong).toHaveCount(0);

    // CLI parity: list, then evaluate the same card without writing the note.
    const listed = await axiIn(vault, env, "glass", "list", "--note", doc);
    const card = listed.magnets.find(magnet => magnet.fields?.title === "Weight dose");
    assert.ok(card, "the calculator card is in the journal");
    assert.equal(card.fields.proposed, false);
    const evaluated = await axiIn(vault, env, "glass", "card", "eval", card.id, "--note", doc, "--input", "dose=2", "--input", "weight=70");
    assert.equal(evaluated.evaluation.ok, true);
    assert.equal(evaluated.evaluation.display, "140");
    assert.equal(evaluated.evaluation.unit, "mg");
    assert.equal(await readFile(path.join(vault, doc), "utf8"), source, "the note is never written");
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await app.close(); }
}

// B. Flow: create, walk, go back, show all steps, render strict Mermaid, and agent proposals.
{
  const { app, page, env, errors } = await boot();
  try {
    await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
    const rich = await openGlass(page);
    await resize(app, page, 1440);
    await rich.locator("p[data-cid]", { hasText: secondLine }).click();
    const dialog = await openDialog(page, "flow");
    await dialog.locator("[data-card-new-title]").fill("Stability flow");
    await dialog.locator("[data-card-new-flow]").fill(flowText);
    await dialog.locator("[data-card-new-citation]").fill("Synthetic guideline (2026)");
    await dialog.locator("[data-card-new-submit]").click();
    await expect(dialog).toHaveCount(0);
    const flowView = flowCard(page);
    await expect(flowView).toHaveCount(1);
    await expect(flowView.locator("[data-flow-question]")).toHaveText("Is the patient stable?");
    await expect(flowView.locator("[data-card-citation]")).toContainText("Synthetic guideline (2026)");
    await flowView.locator('[data-flow-choice="1"]').click();
    await expect(flowView.locator("[data-flow-question]")).toHaveText("Allergic to the synthetic drug?");
    await expect(flowView.locator("[data-card-trail]")).toHaveCount(1);
    await flowView.locator('[data-flow-choice="0"]').click();
    await expect(flowView.locator("[data-flow-result]")).toContainText("Use the synthetic alternative.");
    await expect(flowView.locator("[data-card-flow]")).toHaveAttribute("data-flow-path", "1.0");
    await flowView.locator("[data-flow-back]").click();
    await expect(flowView.locator("[data-flow-question]")).toHaveText("Allergic to the synthetic drug?");
    await flowView.locator("[data-flow-reset]").click();
    await expect(flowView.locator("[data-flow-question]")).toHaveText("Is the patient stable?");

    // Expand all keeps the whole tree reachable in text.
    await flowView.locator("[data-flow-all]").click();
    await expect(flowView.locator("[data-flow-outline]")).toContainText("Question: Allergic to the synthetic drug?");
    await expect(flowView.locator("[data-flow-outline]")).toContainText("Result: Give the synthetic loading dose.");
    await flowView.locator("[data-flow-all]").click();
    await expect(flowView.locator("[data-flow-outline]")).toHaveCount(0);

    // Mermaid renders under securityLevel strict and our own node ids carry the hotspots.
    await flowView.locator("[data-flow-diagram-toggle]").click();
    await expect(flowView.locator("[data-flow-diagram] svg")).toBeVisible({ timeout: 30_000 });
    await expect(flowView.locator("[data-flow-diagram-error]")).toHaveCount(0);
    const nodes = await flowView.locator("[data-flow-diagram] g.node[data-flow-node]").count();
    assert.equal(nodes, 5, "every flow step is a hotspot");
    await flowView.locator('[data-flow-diagram] g.node[data-flow-node="f0_0"]').click();
    await expect(flowView.locator("[data-flow-result]")).toContainText("Follow the synthetic protocol.");
    await expect(flowView.locator("[data-card-flow]")).toHaveAttribute("data-flow-path", "0");

    // Agent-created cards arrive as proposals; nothing walks until the person accepts.
    const near = "Weight-based dosing paragraph for the calculator.";
    const proposedCalc = await axiIn(vault, env, "glass", "card", "add", "--note", doc, "--card", "calc", "--near", near,
      "--title", "Proposed dose", "--formula", "dose * weight", "--unit", "mg",
      "--inputs", JSON.stringify([{ key: "dose", label: "Dose", unit: "mg/kg", min: 0, max: 10 }, { key: "weight", label: "Weight", unit: "kg", min: 0, max: 200 }]),
      "--citation", "Synthetic protocol §7");
    assert.equal(proposedCalc.status, "proposed; Accept it in Omarkie");
    const proposal = page.locator('.glass-card[data-card-kind="calc"]', { hasText: "Proposed dose" });
    await expect(proposal).toHaveCount(1, { timeout: 20_000 });
    await unfold(page, proposal);
    await expect(proposal.locator("[data-card-proposal]")).toBeVisible();
    await expect(proposal.locator("[data-card-proposal-badge]")).toHaveText("Proposal");
    await expect(proposal.locator("[data-card-input]")).toHaveCount(0);
    await proposal.locator("[data-card-accept]").click();
    await expect(proposal.locator("[data-card-proposal]")).toHaveCount(0);
    await expect(proposal.locator('[data-card-input="weight"] input')).toBeVisible();
    await proposal.locator('[data-card-input="dose"] input').fill("2");
    await proposal.locator('[data-card-input="weight"] input').fill("70");
    await expect(proposal.locator("[data-card-value]")).toHaveText("140", { timeout: 10_000 });

    const proposedFlow = await axiIn(vault, env, "glass", "card", "add", "--note", doc, "--card", "flow", "--near", secondLine,
      "--title", "Proposed flow", "--flow", JSON.stringify(flow), "--citation", "Synthetic guideline §2");
    assert.ok(proposedFlow.card);
    const flowProposal = page.locator('.glass-card[data-card-kind="flow"]', { hasText: "Proposed flow" });
    await expect(flowProposal).toHaveCount(1, { timeout: 20_000 });
    await unfold(page, flowProposal);
    await expect(flowProposal.locator("[data-card-preview]")).toBeVisible();
    await expect(flowProposal.locator("[data-flow-question]")).toHaveCount(0);
    await flowProposal.locator("[data-card-accept]").click();
    await expect(flowProposal.locator("[data-flow-question]")).toHaveText("Is the patient stable?");
    assert.equal(await readFile(path.join(vault, doc), "utf8"), source, "the note is never written");
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await app.close(); }
}

// C. Restart: cards, accepted proposals and citations come back from the journal; walk state resets.
{
  const { app, page, errors } = await boot();
  try {
    await openGlass(page);
    await expect(calcCard(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(flowCard(page)).toHaveCount(2);
    const accepted = calcCard(page).filter({ hasText: "Proposed dose" });
    await unfold(page, accepted);
    await expect(accepted.locator("[data-card-proposal]")).toHaveCount(0);
    await expect(accepted.locator('[data-card-input="weight"] input')).toHaveValue("");
    await accepted.locator('[data-card-input="dose"] input').fill("2");
    await accepted.locator('[data-card-input="weight"] input').fill("70");
    await expect(accepted.locator("[data-card-value]")).toHaveText("140");
    const walked = flowCard(page).filter({ hasText: "Stability flow" });
    await unfold(page, walked);
    await expect(walked.locator("[data-flow-question]")).toHaveText("Is the patient stable?");
    await expect(walked.locator("[data-card-citation]")).toContainText("Synthetic guideline (2026)");
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await app.close(); }
}

// D. Screenshots: light and dark, 1440 and 720; both live cards open, diagram rendered.
{
  const { app, page } = await boot(home, vault, doc, source, { OMARKIE_TEST_HIDDEN: "0" });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 720]) {
      await page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
      await page.reload();
      await openGlass(page);
      await resize(app, page, width);
      await expect(page.locator(".glass-card")).toHaveCount(4, { timeout: 30_000 });
      // Calculator: enter a value so the cited result is on the face.
      for (const card of await calcCard(page).all()) {
        await unfold(page, card);
        const doseBox = card.locator('[data-card-input="dose"] input');
        if (await doseBox.count()) { await doseBox.fill("2"); await card.locator('[data-card-input="weight"] input').fill("70"); }
      }
      const calc = page.locator('.glass-card[data-card-kind="calc"]', { hasText: "Weight dose" });
      await unfold(page, calc);
      await calc.locator('[data-card-input="dose"] input').fill("2");
      await calc.locator('[data-card-input="weight"] input').fill("70");
      await expect(calc.locator("[data-card-value]")).toHaveText("140");
      await calc.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(evidence, `g16-calc-${theme}-${width}.png`) });

      // Flow: open the walker on the first decision, then show the strict Mermaid preview.
      const flowView = page.locator('.glass-card[data-card-kind="flow"]', { hasText: "Stability flow" });
      await unfold(page, flowView);
      await flowView.locator("[data-flow-diagram-toggle]").click();
      await expect(flowView.locator("[data-flow-diagram] svg")).toBeVisible({ timeout: 30_000 });
      await flowView.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(evidence, `g16-flow-${theme}-${width}.png`) });
      await flowView.locator("[data-flow-diagram-toggle]").click();
    }
  } finally { await app.close(); }
}
