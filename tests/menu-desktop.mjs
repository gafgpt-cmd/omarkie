import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createServer } from "node:http";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import groups from "../shared/commands.json" with { type: "json" };
import { createTranslator } from "../shared/i18n.mjs";
const t = createTranslator("en");
if (process.platform !== "linux") {
  console.log("SKIP: the Linux in-window menu audit requires Linux; native macOS/Windows acceptance remains separate");
  process.exit(0);
}

const data = await mkdtemp(path.join(os.tmpdir(), "omarkie-menu-"));
const qa = process.env.OMARKIE_QA_DIR || path.join(data, "evidence");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: data, OMARKIE_TEST_HIDDEN: process.env.OMARKIE_TEST_HIDDEN ?? "1", OMARKIE_LANGUAGE: "en", XDG_STATE_HOME: path.join(data, "state"), XDG_CONFIG_HOME: path.join(data, "config"), XDG_DATA_HOME: path.join(data, "share") });
delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
const checks = [], errors = [];
const invokedActions = new Set();
let inventory = [];
let application, page, uploader;
let completed = false;
let chosenPandoc = "";
async function launch() {
  application = await electron.launch({ args: [process.cwd(), ...headlessArguments, "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"], env, timeout: 30000 });
  assert.equal(await application.evaluate(({ app }) => app.commandLine.getSwitchValue("ozone-platform")), "headless");
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Renderer console: " + message.text()); });
  await fullSize(application, page);
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible();
  if (!inventory.length) inventory = await application.evaluate(({ Menu }) => {
    const walk = menu => menu.items.map(item => ({ id: item.id, label: item.label, role: item.role, type: item.type, accelerator: item.accelerator, submenu: item.submenu && walk(item.submenu) }));
    return walk(Menu.getApplicationMenu());
  });
}
const rich = () => page.locator(".document-editor:not([hidden]) .rich-document");
async function menu(group, name) {
  await page.mouse.move(0, 0);
  const more = page.getByRole("button", { name: t("更多操作"), exact: true });
  if (await more.getAttribute("aria-expanded") === "true") await more.press("Enter");
  const opener = page.locator(".menu-bar").getByRole("button", { name: group, exact: true });
  if (await opener.getAttribute("aria-expanded") !== "true") await opener.press("Enter");
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(".menu-bar-panel");
  const item = panel.getByRole("menuitem", { name, exact: true }).or(panel.getByRole("menuitemcheckbox", { name, exact: true }));
  await expect(item).toBeEnabled();
  await item.press("Enter");
}
const preferences = () => page.getByRole("dialog", { name: "Preferences", exact: true });
function pass(item, expected, observed = expected) { checks.push({ item, expected, observed, result: "PASS" }); console.log("PASS: " + item); }
async function audit(item, run) {
  try { await run(); }
  catch (error) {
    const detail = error.message + "\n" + (await page.getByRole("alert").allTextContents()).join("\n");
    checks.push({ item, expected: "Observable command effect", observed: detail, result: "FAIL" });
    console.error("FAIL: " + item + "\n" + detail);
    await page.keyboard.press("Escape");
  }
}
async function command(action, route = "menu") {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  invokedActions.add(action);
  const group = groups.find(group => group.items.some(item => item.action === action));
  const item = group?.items.find(item => item.action === action);
  if (route === "shortcut") {
    const key = item.pcKey ?? item.key;
    assert.ok(key, action + " has a shortcut");
    const translate = createTranslator(await page.locator("html").getAttribute("lang"));
    const previous = await page.evaluateHandle(() => document.activeElement);
    const opener = page.locator(".menu-bar").getByRole("button", { name: ["preferences", "plugins", "close-window"].includes(action) ? "Omarkie" : translate(group.title), exact: true });
    if (await opener.getAttribute("aria-expanded") !== "true") await opener.press("Enter");
    const panel = page.locator(".menu-bar-panel");
    const advertised = panel.getByRole("menuitem", { name: translate(item.label), exact: true }).or(panel.getByRole("menuitemcheckbox", { name: translate(item.label), exact: true }));
    await expect(advertised.locator("kbd")).toHaveText(key.replaceAll("Mod-", "Ctrl+").replaceAll("Ctrl-", "Ctrl+").replaceAll("Shift-", "Shift+").replaceAll("Alt-", "Alt+"));
    await opener.press("Enter"); await previous.evaluate(element => element?.focus()); await previous.dispose();
    if (["new", "open", "save", "saveAs", "close-window"].includes(action)) {
      await application.evaluate(({ BrowserWindow }, key) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const modifiers = ["control", ...(key.includes("Shift-") ? ["shift"] : [])];
        const keyCode = key.split("-").at(-1).toUpperCase();
        contents.focus();
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }, key);
    } else await page.keyboard.press(key.replaceAll("Mod-", "Control+").replaceAll("Ctrl-", "Control+").replaceAll("Shift-", "Shift+").replaceAll("Alt-", "Alt+"));
  } else if (route === "toolbar") {
    if (action === "source") { await page.locator(".source-toggle").click({ force: true }); return; }
    if (action === "sidebar") { await page.getByRole("button", { name: t("切换侧栏"), exact: true }).click({ force: true }); return; }
    const expanded = page.locator('.menu-bar button[aria-haspopup="menu"][aria-expanded="true"]');
    if (await expanded.count()) await expanded.press("Enter");
    const opener = page.getByRole("button", { name: t("更多操作"), exact: true });
    if (await opener.getAttribute("aria-expanded") !== "true") await opener.press("Enter");
    const label = t(({ new: "新建文档", open: "打开文件", pdf: "导出 PDF" })[action] || item.label);
    const panel = page.locator(".more-menu:not(.menu-bar-panel)");
    const button = panel.getByRole("menuitem", { name: label, exact: true }).or(panel.getByRole("menuitemcheckbox", { name: label, exact: true }));
    await expect(button).toBeEnabled(); await button.click({ force: true });
  } else if (route === "native") {
    await application.evaluate(({ Menu, BrowserWindow }, { action, label }) => {
      const find = menu => menu.items.find(item => item.label === label) || menu.items.map(item => item.submenu && find(item.submenu)).find(Boolean);
      const item = Menu.getApplicationMenu().getMenuItemById(action) || find(Menu.getApplicationMenu());
      const window = BrowserWindow.getAllWindows()[0];
      item.click({}, window, window.webContents);
    }, { action, label: t(item.label) });
  } else await menu(["preferences", "plugins", "close-window"].includes(action) ? "Omarkie" : t(group.title), t(item.label));
}
async function fixture(content) {
  const file = path.join(data, "audit-" + checks.length + ".md");
  await writeFile(file, content, "utf8");
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  await command("open");
  if (await page.locator(".source-toggle").getAttribute("aria-pressed") === "true") await command("source");
  await expect(page.locator(".document-title")).toContainText(path.basename(file));
  await expect(rich()).toBeVisible();
  return file;
}
async function sourceText() {
  await command("source");
  const source = page.locator(".document-editor:not([hidden]) .cm-content");
  await expect(source).toBeVisible();
  const text = (await source.locator(".cm-line").allTextContents()).join("\n");
  await command("source");
  return text;
}
try {
  await launch();
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("bold").enabled)).toBe(true);
  await command("source");
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("bold").enabled)).toBe(false);
  await command("source");
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("bold").enabled)).toBe(true);
  pass("Native context availability", "Rich formatting is disabled while source mode is active");
  for (const action of ["focus", "typewriter"]) {
    await command(action, "shortcut");
    const opener = page.getByRole("button", { name: t("更多操作"), exact: true });
    await opener.press("Enter");
    const label = t(groups.flatMap(group => group.items).find(item => item.action === action).label);
    const toggle = page.locator(".more-menu:not(.menu-bar-panel)").getByRole("menuitemcheckbox", { name: label, exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle.locator(".lucide-check")).toHaveCount(1);
    await opener.press("Enter"); await command(action, "shortcut");
    pass(`More checked mark: ${action}`, "Visible checkmark and ARIA state match the active writing mode");
  }
  if (!process.argv.includes("--commands-only") && !process.argv.includes("--workflows-only") && !process.argv.includes("--files-only")) {
  await expect(rich().getByRole("heading", { name: /Seven Days on the Lighthouse Coast/ })).toBeVisible();
  await page.getByRole("button", { name: "space-explainer.md", exact: true }).click({ force: true });
  await expect(rich().getByRole("heading", { name: /How Far Is a Light-Year/ })).toBeVisible();
  await menu("Help", "Showcase Examples");
  await expect(rich().getByRole("heading", { name: /Seven Days on the Lighthouse Coast/ })).toBeVisible();
  pass("Help > Showcase Examples", "Opens the bundled showcase");
  await page.getByRole("button", { name: "space-explainer.md", exact: true }).click({ force: true });
  await expect(rich().getByRole("heading", { name: /How Far Is a Light-Year/ })).toBeVisible();
  await command("showcase", "native");
  await expect(rich().getByRole("heading", { name: /Seven Days on the Lighthouse Coast/ })).toBeVisible();
  pass("Native Help > Showcase Examples", "Switches from another document to the bundled travel journal");
  await page.getByRole("button", { name: "space-explainer.md", exact: true }).click({ force: true });
  await expect(rich().getByRole("heading", { name: /How Far Is a Light-Year/ })).toBeVisible();
  await menu("Omarkie", "Preferences…");
  const hasHelvetica = await page.evaluate(async () => { try { await new FontFace("audit-local", 'local("Helvetica Neue")').load(); return true; } catch { return false; } });
  if (!hasHelvetica) {
    await page.evaluate(() => { const value = JSON.parse(localStorage.getItem("omarkie-preferences")); localStorage.setItem("omarkie-preferences", JSON.stringify({ ...value, documentFont: "helvetica" })); });
    await page.reload(); await expect(rich()).toBeVisible();
    await page.getByRole("button", { name: "space-explainer.md", exact: true }).click({ force: true });
    await expect(rich().getByRole("heading", { name: /How Far Is a Light-Year/ })).toBeVisible();
    await command("preferences");
    await expect(preferences().getByLabel("Text font", { exact: true })).toHaveValue("theme");
    await expect(preferences().getByLabel("Text font", { exact: true }).locator('option[value="helvetica"]')).toHaveCount(0);
    pass("Unavailable saved local font", "Unavailable selection returns to theme default and is not offered");
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const targets = [["Text font", ".rich-document p"], ["Heading font", ".rich-document h1"], ["Code font", ".rich-document .fence-body:visible"], ["Interface font", ".menu-bar-item > button"]];
  const families = { "open-sans": "Open Sans", "pt-serif": "PT Serif", merriweather: "Merriweather", lato: "Lato", vollkorn: "Vollkorn", helvetica: "Helvetica Neue", "toypora-mono": "Lucida Console", literata: "Literata", inter: "Inter", "jetbrains-mono": "JetBrains Mono", "liberation-sans": "Arimo", "liberation-serif": "Tinos" };
  for (const [label, selector] of targets) {
    const select = preferences().getByLabel(label, { exact: true });
    const choices = await select.locator("option").evaluateAll(options => options.map(option => ({ id: option.value, name: option.textContent })));
    for (const { id, name } of choices) {
      await select.selectOption(id);
      const target = page.locator(".document-editor:not([hidden]) " + selector).first();
      const element = label === "Interface font" ? page.locator(selector).first() : target;
      await element.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) if (/[A-Za-z]/.test(node.textContent || "") && node.parentElement.getClientRects().length) {
          node.parentElement.dataset.fontAudit = "true";
          node.parentElement.getBoundingClientRect();
          return;
        }
        throw new Error("Font target has no visible text");
      });
      await page.evaluate(() => document.fonts.ready);
      const computed = await element.evaluate(element => getComputedStyle(element).fontFamily);
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-font-audit="true"]' });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.some(font => font.glyphCount > 0), `${label} ${name}: actual glyphs are rendered`);
      await page.locator('[data-font-audit="true"]').evaluate(element => { delete element.dataset.fontAudit; });
      if (families[id]) {
        const expected = families[id];
        assert.ok(computed.includes(expected), `${label} ${name}: computed ${computed}`);
        assert.equal(name, expected, `${label}: label names the actual font`);
        if (["helvetica", "toypora-mono"].includes(id)) {
          assert.ok(await page.evaluate(async family => { try { await new FontFace("audit-local", `local("${family}")`).load(); return true; } catch { return false; } }, expected), `${name}: chosen local face exists, no silent fallback`);
        } else {
          assert.ok(await page.evaluate(async family => (await document.fonts.load(`16px "${family}"`, "Omarkie")).some(face => face.status === "loaded"), expected), `${name}: bundled face loads`);
        }
        const renderedFamilies = [expected, ...({ "jetbrains-mono": ["JetBrainsMono Nerd Font"], "liberation-sans": ["Liberation Sans"], "liberation-serif": ["Liberation Serif"] }[id] || [])];
        assert.ok(fonts.some(font => font.glyphCount > 0 && renderedFamilies.some(family => font.familyName.replaceAll(" ", "").toLowerCase().includes(family.replaceAll(" ", "").toLowerCase()))), `${label} ${name}: selected face renders actual glyphs (${fonts.map(font => font.familyName)})`);
      } else assert.ok(computed, `${name}: computed font`);
      pass(`${label}: ${name}`, "Matching element uses a loaded font", `${computed}; ${fonts.map(font => font.familyName).join(", ")}`);
    }
    await select.selectOption("theme");
  }
  const size = preferences().getByLabel("Body font size", { exact: true });
  for (const n of [20, 14, 28, 12, 19]) {
    await size.fill(String(n)); await expect(rich()).toHaveCSS("font-size", `${n}px`);
  }
  pass("Body font size increase/decrease/bounds", "Computed font size follows the control from 12 to 28 px");
  await preferences().getByLabel("Text font", { exact: true }).selectOption("literata");
  await preferences().getByLabel("Heading font", { exact: true }).selectOption("inter");
  await preferences().getByLabel("Code font", { exact: true }).selectOption("jetbrains-mono");
  await preferences().getByLabel("Interface font", { exact: true }).selectOption("lato");
  await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
  await application.close(); await launch();
  await expect(rich()).toHaveCSS("font-size", "19px");
  await expect(rich()).toHaveCSS("font-family", /Literata/);
  await expect(rich().locator("h1")).toHaveCSS("font-family", /Inter/);
  await expect(rich().locator(".fence-body:visible").first()).toHaveCSS("font-family", /JetBrains/);
  await expect(page.locator(".menu-bar-item > button").first()).toHaveCSS("font-family", /Lato/);
  pass("Font and size restart persistence", "19 px Literata survives a full app restart");
  await menu("Omarkie", "Preferences…");
  await preferences().getByRole("button", { name: "Restore Toypora classic reading", exact: true }).click({ force: true });
  await expect(rich()).toHaveCSS("font-size", "16px");
  await expect(rich()).toHaveCSS("font-family", /Open Sans/);
  for (const label of ["Text font", "Heading font", "Code font", "Interface font"]) await expect(preferences().getByLabel(label, { exact: true })).toHaveValue("theme");
  await expect(preferences().getByLabel("Theme", { exact: true })).toHaveValue("toypora");
  pass("Restore Toypora classic reading", "Resets fonts, size and theme");
  await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
  await rich().focus(); await page.keyboard.press("F9");
  await expect(page.locator(".app-shell")).toHaveClass(/typewriter-mode/);
  await page.locator(".menu-bar").getByRole("button", { name: "Display", exact: true }).press("Enter");
  await expect(page.locator(".menu-bar-panel").getByRole("menuitemcheckbox", { name: /Typewriter Mode/ })).toBeChecked();
  await page.keyboard.press("Escape"); await page.keyboard.press("F9");
  pass("Typewriter menu check", "Checked mark follows keyboard state");
  await page.locator(".menu-bar").getByRole("button", { name: "File", exact: true }).press("Enter");
  await expect(page.locator(".menu-bar-panel").getByText("New Window", { exact: true })).toHaveCount(0);
  await expect(page.locator(".menu-bar-panel").getByText("New Tab", { exact: true })).toHaveCount(0);
  assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("newWindow") != null), false);
  assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("newTab") != null), false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: t("更多操作"), exact: true }).click({ force: true });
  await expect(page.locator(".more-menu:not(.menu-bar-panel)").getByText("New Window", { exact: true })).toHaveCount(0);
  await expect(page.locator(".more-menu:not(.menu-bar-panel)").getByText("New Tab", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  pass("Unsupported Electron window/tab commands", "Unavailable native window controls are hidden");
  for (const [action, key, className] of [["focus", "F8", "focus-mode"], ["typewriter", "F9", "typewriter-mode"], ["sidebar", "Control+Shift+l", "sidebar-hidden"]]) {
    for (const route of ["menu", "toolbar", "native", "shortcut"]) {
      await rich().focus();
      const before = (await page.locator(".app-shell").getAttribute("class")).includes(className);
      await command(action, route);
      await expect.poll(async () => (await page.locator(".app-shell").getAttribute("class")).includes(className)).toBe(!before);
      const checked = action === "sidebar" ? before : !before;
      await expect.poll(() => application.evaluate(({ Menu }, action) => Menu.getApplicationMenu().getMenuItemById(action).checked, action)).toBe(checked);
      await page.locator(".menu-bar").getByRole("button", { name: "Display", exact: true }).press("Enter");
      await expect(page.getByRole("menuitemcheckbox", { name: t(groups.flatMap(group => group.items).find(item => item.action === action).label), exact: true })).toHaveAttribute("aria-checked", String(checked));
      await page.keyboard.press("Escape");
      await command(action);
      pass(`${action}: ${route} (${key})`, "Observable view and both menu checkmarks agree");
    }
  }
  await command("preferences", "shortcut");
  const themeSelect = preferences().getByLabel("Theme", { exact: true });
  const themeIds = await themeSelect.locator("option").evaluateAll(options => options.map(option => option.value));
  for (const [index, id] of themeIds.entries()) {
    await themeSelect.selectOption(id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await expect(preferences().locator('.theme-choice[aria-pressed="true"]')).toHaveCount(1);
    const ink = await preferences().locator('.theme-choice[aria-pressed="true"] .theme-preview').evaluate(element => getComputedStyle(element).color);
    await expect(rich()).toHaveCSS("color", ink);
    pass(`Theme: ${id}`, "Theme and selected preview change together");
    await themeSelect.selectOption(id === "toypora" ? "light" : "toypora");
    await preferences().locator(".theme-choice").nth(index).click({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await expect(rich()).toHaveCSS("color", ink);
    pass(`Theme preview button: ${id}`, "Clicking the preview applies the advertised colors");
  }
  await themeSelect.selectOption("toypora");
  const preferenceState = () => page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-preferences")));
  for (const [key, label, value] of [["readingSpeed", "阅读速度（词/分钟）", 300], ["tabSize", "缩进宽度", 4], ["imageFolder", "复制图片到", "audit images"], ["imageUploader", "PicGo Server 地址", "http://127.0.0.1:36677/upload"], ["pdfPaper", "PDF 纸张", "letter"], ["pdfMargin", "PDF 页边距", 45], ["pdfHeader", "PDF 页眉", "Audit header"], ["pdfFooter", "PDF 页脚", "Audit footer"]]) {
    const field = preferences().getByLabel(t(label), { exact: true });
    if (await field.evaluate(element => element.tagName === "SELECT")) await field.selectOption(String(value));
    else await field.fill(String(value));
    await expect.poll(async () => (await preferenceState())[key]).toBe(value);
    pass(`Preferences: ${t(label)}`, "Control saves its value for its consumer", String(value));
  }
  for (const [key, label] of [["imageAutoUpload", "插入后通过 PicGo 自动上传"], ["remoteImages", "显示远程图片"], ["imagePrefix", "相对图片路径使用 ./ 前缀"], ["imageEscape", "自动转义图片路径"], ["spellcheck", "拼写检查"], ["autoPair", "自动配对括号与引号"], ["highlight", "高亮：==文字=="], ["subscript", "下标：H~2~O"], ["superscript", "上标：X^2^"], ["emoji", "Emoji：:smile:"], ["inlineMath", "行内公式：$x^2$"]]) {
    const field = preferences().getByLabel(t(label), { exact: true });
    for (const checked of [false, true]) {
      await field.setChecked(checked, { force: true });
      await expect.poll(async () => (await preferenceState())[key]).toBe(checked);
      if (key === "spellcheck") await expect(rich()).toHaveAttribute("spellcheck", String(checked));
    }
    if (["imageAutoUpload", "remoteImages"].includes(key)) await field.uncheck({ force: true });
    pass(`Preferences: ${t(label)}`, "Both checkbox states save; remote access restored to off");
  }
  const css = path.join(data, "audit-theme.css");
  await writeFile(css, ".rich-document { color: rgb(12, 34, 56) !important; }", "utf8");
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, css);
  await preferences().getByRole("button", { name: t("安装 CSS 主题…"), exact: true }).click({ force: true });
  await expect(rich()).toHaveCSS("color", "rgb(12, 34, 56)");
  pass("Install CSS theme", "Installed CSS changes actual document style");
  await themeSelect.selectOption("toypora");
  await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
  await fixture("Audit text\n\n==marked== H~2~O X^2^ :smile: $x^2$\n");
  await command("preferences");
  for (const [label, selector] of [["高亮：==文字==", "mark"], ["下标：H~2~O", "sub"], ["上标：X^2^", "sup"], ["行内公式：$x^2$", ".mathjax-node"]]) {
    const field = preferences().getByLabel(t(label), { exact: true });
    await field.uncheck({ force: true }); await expect(rich().locator(selector)).toHaveCount(0);
    await field.check({ force: true }); await expect(rich().locator(selector)).toHaveCount(1);
    pass(`Render preference: ${t(label)}`, "Disabling and enabling changes actual rendered syntax");
  }
  await preferences().getByLabel(t("Emoji：:smile:"), { exact: true }).uncheck({ force: true });
  await expect(rich()).toContainText(":smile:");
  await preferences().getByLabel(t("Emoji：:smile:"), { exact: true }).check({ force: true });
  await expect(rich()).toContainText("😄");
  pass("Emoji rendering preference", "Literal shortcode switches to actual emoji");
  await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
  for (const paired of [false, true]) {
    await fixture("Audit text\n");
    await command("preferences");
    await preferences().getByLabel(t("自动配对括号与引号"), { exact: true }).setChecked(paired, { force: true });
    await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
    await rich().focus(); await page.keyboard.press("End"); await page.keyboard.type("(");
    const text = await sourceText();
    assert.equal(text.includes("()"), paired);
    pass(`Auto-pair: ${paired}`, "Typing creates a closing bracket only when enabled");
  }
  await fixture("Audit text\n"); await command("source");
  const source = page.locator(".document-editor:not([hidden]) .cm-content");
  await expect(source).toBeVisible();
  await source.locator(".cm-line").first().click({ force: true }); await page.keyboard.press("Home"); await page.keyboard.press("Tab");
  await expect.poll(() => source.locator(".cm-line").first().textContent()).toBe("    Audit text");
  await command("source");
  pass("Indent width preference", "Tab inserts the selected four spaces in source mode");
  await fixture("word ".repeat(600));
  for (const [speed, minutes] of [[50, 12], [300, 2]]) {
    await command("preferences");
    await preferences().getByLabel(t("阅读速度（词/分钟）"), { exact: true }).fill(String(speed));
    await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
    await command("statistics");
    await expect(page.getByRole("dialog").locator("dd").last()).toHaveText(t("{{count}} 分钟", { count: minutes }));
    await page.keyboard.press("Escape");
    pass(`Reading speed: ${speed}`, "Actual reading-time estimate changes", `${minutes} minutes for 600 words`);
  }
  const remoteImage = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#96abc1" } }).png().toBuffer();
  await page.route("https://example.invalid/audit-remote.png", route => route.fulfill({ contentType: "image/png", body: remoteImage }));
  await fixture("Audit text\n\n![remote](https://example.invalid/audit-remote.png)\n");
  await expect(rich().locator(".remote-image")).toHaveCount(1);
  await expect(rich().locator("img")).toHaveCount(0);
  await command("preferences"); await preferences().getByLabel(t("显示远程图片"), { exact: true }).check({ force: true });
  await expect(rich().locator("img")).toHaveAttribute("src", "https://example.invalid/audit-remote.png");
  await preferences().getByLabel(t("显示远程图片"), { exact: true }).uncheck({ force: true });
  await expect(rich().locator("img")).toHaveCount(0);
  await expect(rich().locator(".remote-image")).toHaveCount(1);
  await preferences().getByRole("button", { name: "Done", exact: true }).click({ force: true });
  await page.unroute("https://example.invalid/audit-remote.png");
  pass("Remote image permission", "Off blocks image elements, On enables them, Off blocks them again; test URL intercepted locally");
  }
  if (!process.argv.includes("--workflows-only") && !process.argv.includes("--files-only")) {
  const edits = [
    ...Array.from({ length: 6 }, (_, index) => ["heading-" + (index + 1), "Audit text\n", new RegExp("^" + "#".repeat(index + 1) + " Audit text")]),
    ["heading-0", "# Audit text\n", /^Audit text/],
    ["heading-up", "## Audit text\n", /^# Audit text/], ["heading-down", "# Audit text\n", /^## Audit text/],
    ["bold", "Audit text\n", /\*\*Audit text\*\*/], ["italic", "Audit text\n", /\*Audit text\*/],
    ["underline", "Audit text\n", /<u>Audit text<\/u>/], ["strike", "Audit text\n", /~~Audit text~~/],
    ["inline-code", "Audit text\n", /`Audit text`/], ["comment", "Audit text\n", /<!-- Audit text -->/],
    ["highlight", "Audit text\n", /==Audit text==/], ["superscript", "Audit text\n", /\^Audit text\^/], ["subscript", "Audit text\n", /~Audit text~/],
    ["clear-format", "**Audit text**\n", /^Audit text/],
    ["quote", "Audit text\n", /> Audit text/], ["ordered-list", "Audit text\n", /1\. Audit text/], ["unordered-list", "Audit text\n", /[-*] Audit text/],
    ["task-list", "Audit text\n", /[-*] \[ \] Audit text/], ["code", "Audit text\n", /```/], ["math-block", "Audit text\n", /\$\$/],
    ["hr", "Audit text\n", /---/], ["toc", "Audit text\n", /\[toc\]/i], ["yaml", "Audit text\n", /^---/],
  ];
  for (const [action, initial, expected] of edits) {
    const definition = groups.flatMap(group => group.items).find(item => item.action === action);
    for (const route of ["menu", "toolbar", "native", ...((definition.pcKey ?? definition.key) ? ["shortcut"] : [])]) {
      await audit(`${action}: ${route}`, async () => {
      const file = await fixture(initial);
      await rich().getByText("Audit text", { exact: true }).first().click({ force: true });
      if (["bold", "italic", "underline", "strike", "inline-code", "comment", "highlight", "superscript", "subscript", "clear-format"].includes(action)) {
        await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
      }
      await command(action, route);
      await expect.poll(() => readFile(file, "utf8")).toMatch(expected);
      assert.match(await sourceText(), expected, `${action}: ${route}`);
      pass(`${action}: ${route}`, "Command changes actual Markdown", String(expected));
      });
    }
  }
  for (const kind of ["html", "pdf", "docx", "rtf", "odt", "epub", "latex", "rst", "mediawiki", "textile", "opml", "revealjs"]) {
    for (const route of ["menu", "toolbar", "native"]) await audit(`Export ${kind}: ${route}`, async () => {
    await fixture("# Audit\n\nAudit text\n");
    const output = path.join(data, `export-${route}.` + kind);
    const savedPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-preferences")));
    if (kind === "pdf") await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents, print = contents.printToPDF.bind(contents);
      contents.printToPDF = options => { globalThis.auditPrintOptions = options; return print(options); };
    });
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await command(kind, route);
    await expect.poll(async () => { try { return (await readFile(output)).length; } catch { return 0; } }, { timeout: 60000 }).toBeGreaterThan(20);
    const bytes = await readFile(output);
    if (kind === "pdf") {
      assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
      const options = await application.evaluate(() => globalThis.auditPrintOptions);
      assert.equal(options.pageSize, savedPreferences.pdfPaper === "letter" ? "Letter" : "A4");
      assert.deepEqual(Object.values(options.margins), Array(4).fill(savedPreferences.pdfMargin / 72));
      assert.ok(options.headerTemplate.includes(savedPreferences.pdfHeader));
      assert.ok(options.footerTemplate.includes(savedPreferences.pdfFooter));
      pass("PDF paper, margins, header and footer", "PDF engine consumes selected preferences while producing actual PDF");
    }
    else if (["docx", "odt", "epub"].includes(kind)) assert.equal(bytes.subarray(0, 2).toString(), "PK");
    else assert.match(bytes.toString(), /Audit/);
    pass(`Export ${kind}: ${route}`, "Actual nonempty output with expected content or file signature");
    });
  }
  for (const action of ["outline", "files", "file-tree"]) {
    for (const route of ["menu", "toolbar", "native", "shortcut"]) {
      await rich().focus(); await command(action, route);
      await expect.poll(() => application.evaluate(({ Menu }, action) => Menu.getApplicationMenu().getMenuItemById(action).checked, action)).toBe(true);
      await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-hidden/);
      if (action === "file-tree") await expect(page.getByRole("tree")).toBeVisible();
      if (action === "outline") await expect(page.locator(".outline")).toBeVisible();
      pass(`${action}: ${route}`, "Sidebar opens chosen view and native checkmark agrees");
    }
  }
  }
  if (!process.argv.includes("--files-only")) {
  for (const [action, title] of [["preferences", "偏好设置"], ["plugins", "插件管理"], ["quick-open", "快速打开"], ["statistics", "字数统计"], ["recent", "最近文件与文件夹"], ["global-search", "搜索文件夹内容"], ["encoding", "文本编码"]]) {
    const definition = groups.flatMap(group => group.items).find(item => item.action === action);
    for (const route of ["menu", "toolbar", "native", ...((definition.pcKey ?? definition.key) ? ["shortcut"] : [])]) {
      await rich().focus(); await command(action, route);
      await expect(page.getByRole("dialog", { name: t(title), exact: true })).toBeVisible();
      await expect(page.getByRole("dialog").locator(":focus")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      pass(`${action}: ${route}`, "Opens its working dialog");
    }
  }
  const tableText = "|Audit|Other|Third|\n|---|---|---|\n|one|two|three|\n|four|five|six|\n|seven|eight|nine|\n";
  for (const definition of groups.find(group => group.title === "表格").items) {
    for (const route of ["menu", "toolbar", "native", ...(definition.key ? ["shortcut"] : [])]) {
      const file = await fixture(tableText);
      await rich().locator("td").nth(4).click({ force: true });
      await command(definition.action, route);
      await expect.poll(() => readFile(file, "utf8")).not.toBe(tableText);
      const text = await sourceText();
      assert.notEqual(text, tableText, `${definition.action}: ${route} changes table`);
      if (definition.action === "table-deleteTable") assert.ok(!text.includes("|"));
      else if (definition.action === "table-row") assert.equal(text.split("\n").filter(line => line.startsWith("|")).length, 6);
      else if (definition.action === "table-removeRow") assert.equal(text.split("\n").filter(line => line.startsWith("|")).length, 4);
      pass(`${definition.action}: ${route}`, "Table structure or alignment changes in Markdown");
    }
  }
  for (const [action, initial, expected] of [["task-toggle", "- [ ] Audit text\n", /\[x\]/], ["task-done", "- [ ] Audit text\n", /\[x\]/], ["task-undone", "- [x] Audit text\n", /\[ \]/], ["indent", "- Parent\n- Audit text\n", /  - Audit/], ["outdent", "- Parent\n  - Audit text\n", /\n- Audit/], ["paragraph-above", "Audit text\n", /^\n/], ["paragraph-below", "Audit text\n", /Audit text\n\n/]]) {
    const definition = groups.flatMap(group => group.items).find(item => item.action === action);
    for (const route of ["menu", "toolbar", "native", ...(definition.key ? ["shortcut"] : [])]) {
      const file = await fixture(initial); await rich().getByText("Audit text", { exact: true }).click({ force: true }); await command(action, route);
      await expect.poll(() => readFile(file, "utf8")).toMatch(expected);
      assert.match(await sourceText(), expected, action);
      pass(`${action}: ${route}`, "Document transaction changes the intended block");
    }
  }
  for (const action of ["table", "link", "reference-link", "footnote"]) {
    const definition = groups.flatMap(group => group.items).find(item => item.action === action);
    for (const route of ["menu", "toolbar", "native", ...((definition.pcKey ?? definition.key) ? ["shortcut"] : [])]) {
      await fixture("Audit text\n"); await rich().click({ force: true }); await command(action, route);
      const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
      if (action === "link" || action === "reference-link") {
        await dialog.getByLabel(t("显示文字"), { exact: true }).fill("Audit link");
        await dialog.getByLabel(t("链接地址"), { exact: true }).fill("https://example.invalid/audit");
      } else if (action === "footnote") await dialog.getByLabel(t("脚注内容"), { exact: true }).fill("Audit note");
      await dialog.getByRole("button", { name: t("插入"), exact: true }).click({ force: true });
      const text = await sourceText();
      assert.match(text, action === "table" ? /\|/ : action === "footnote" ? /Audit note/ : /example\.invalid/);
      pass(`${action}: ${route}`, "Dialog inserts requested Markdown");
    }
  }
  await fixture("Audit text Audit text\n");
  await command("find", "shortcut");
  await page.getByLabel(t("查找内容"), { exact: true }).fill("Audit");
  await page.getByLabel(t("替换内容"), { exact: true }).fill("Changed");
  for (const action of ["find-next", "find-previous"]) for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await rich().focus(); await command(action, route);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("Audit");
    pass(`${action}: ${route}`, "Selects the actual matching text");
  }
  await page.getByRole("button", { name: t("全部替换"), exact: true }).click({ force: true });
  await expect(rich()).toContainText("Changed text Changed text");
  await page.getByRole("button", { name: t("关闭查找"), exact: true }).click({ force: true });
  pass("Find and replace all", "All matching document text is replaced");
  }
  const autosaveFile = await fixture("Audit text\n");
  await page.getByRole("button", { name: t("更多操作"), exact: true }).click({ force: true });
  const autosave = page.getByRole("menuitemcheckbox", { name: t("自动保存已有文件"), exact: true });
  await expect(autosave).toHaveAttribute("aria-checked", "true");
  await autosave.click({ force: true }); await expect(autosave).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await rich().getByText("Audit text", { exact: true }).click({ force: true }); await page.keyboard.press("End"); await page.keyboard.type(" paused");
  await page.waitForTimeout(1600);
  assert.equal(await readFile(autosaveFile, "utf8"), "Audit text\n");
  await page.reload(); await expect(rich()).toContainText("paused");
  await page.getByRole("button", { name: t("更多操作"), exact: true }).click({ force: true });
  await expect(autosave).toHaveAttribute("aria-checked", "false"); await page.keyboard.press("Escape");
  await command("save"); await expect.poll(() => readFile(autosaveFile, "utf8")).toContain("paused");
  await rich().getByText(/Audit text/).first().click({ force: true }); await page.keyboard.press("End"); await page.keyboard.type(" resumed");
  await page.getByRole("button", { name: t("更多操作"), exact: true }).click({ force: true });
  await autosave.click({ force: true }); await expect(autosave).toHaveAttribute("aria-checked", "true"); await page.keyboard.press("Escape");
  await expect.poll(() => readFile(autosaveFile, "utf8")).toContain("resumed");
  pass("More > Autosave Existing Files", "Off pauses disk saves and survives reload; manual Save works; On resumes saving");
  await page.getByRole("button", { name: t("更多操作"), exact: true }).click({ force: true });
  await page.locator(".more-menu:not(.menu-bar-panel)").getByRole("menuitem", { name: /^About Omarkie/ }).click({ force: true });
  await expect(page.getByRole("dialog")).toContainText("0.1.2");
  await page.getByRole("button", { name: t("关闭关于"), exact: true }).click({ force: true });
  pass("More > About Omarkie", "More menu opens actual version dialog");
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    const original = await fixture("Audit text\n");
    await rich().click({ force: true }); await page.keyboard.press("End"); await page.keyboard.type(" saved");
    await command("save", route);
    await expect.poll(() => readFile(original, "utf8")).toContain("saved");
    const copy = path.join(data, `save-as-${route}.md`);
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, copy);
    await command("saveAs", route);
    await expect.poll(() => readFile(copy, "utf8").catch(() => "")).toContain("saved");
    const documentCount = await page.locator(".document-editor").count();
    await rich().focus(); await command("new", route);
    await expect(rich()).not.toContainText("saved");
    await expect(page.locator(".document-editor")).toHaveCount(documentCount + 1);
    await rich().focus(); await page.keyboard.type("New saved");
    const untitled = path.join(data, `save-new-${route}.md`);
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, untitled);
    await command("save", route);
    await expect.poll(() => readFile(untitled, "utf8").catch(() => "")).toContain("New saved");
    pass(`Save, Save As and New: ${route}`, "Edits and copy reach disk; New opens empty document");
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, copy);
    await command("open", route);
    await expect(rich()).toContainText("saved");
    pass(`Open: ${route}`, "Selected file is displayed");
  }
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await fixture("Audit text\n"); await rich().click({ force: true }); await page.keyboard.press("End"); await page.keyboard.type(" changed");
    await command("undo", route); await expect(rich()).not.toContainText("changed");
    await command("redo", route); await expect(rich()).toContainText("changed");
    pass(`Undo and Redo: ${route}`, "Undo removes the edit and Redo restores it");
  }
  for (const route of ["menu", "native", "shortcut"]) {
    await fixture("Audit text\n"); await rich().getByText("Audit text", { exact: true }).click({ force: true }); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("Audit text");
    await application.evaluate(({ clipboard }) => clipboard.writeText("Copy has not run"));
    await command("copy", route);
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe("Audit text");
    await command("cut", route); await expect(rich()).not.toContainText("Audit text");
    await command("paste", route); await expect(rich()).toContainText("Audit text");
    await command("select-all", route); await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain("Audit text");
    pass(`Copy, Cut, Paste and Select All: ${route}`, "Clipboard and document content change");
  }
  for (const route of ["menu", "native", "shortcut"]) {
    await fixture("Audit text\n"); await rich().getByText("Audit text", { exact: true }).click({ force: true });
    await command("select-all", route);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain("Audit text");
    pass(`Select All: ${route}`, "Actual document text is selected");
  }
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await fixture("Audit text\n"); await rich().getByText("Audit text", { exact: true }).click({ force: true }); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
    await command("copy-markdown", route);
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe("Audit text");
    await application.evaluate(({ clipboard }) => clipboard.writeText("Plain replacement"));
    await command("paste-plain", route); await expect(rich()).toContainText("Plain replacement");
    pass(`Copy Markdown and Paste Plain: ${route}`, "Clipboard source and plain insertion work");
  }
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await fixture(Array.from({ length: 50 }, (_, index) => `Paragraph ${index}\n\n`).join("") + "Audit target\n");
    await rich().getByText("Audit target", { exact: true }).click({ force: true });
    await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
    const scroller = page.locator(".document-editor:not([hidden]) .rich-scroller");
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await command("jump-selection", route);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("Audit target");
    pass(`Jump to Selection: ${route}`, "Selected text scrolls back into view");
  }
  for (const [action, expected] of [["select-word", "Audit"], ["select-line", "Audit text"], ["select-scope", "Audit text"]]) {
    for (const route of ["menu", "toolbar", "native", "shortcut"]) {
      await fixture("Audit text\n"); await rich().getByText("Audit text", { exact: true }).click({ force: true }); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
      await command(action, route);
      await expect.poll(() => page.evaluate(() => getSelection()?.toString().trim())).toBe(expected);
      pass(`${action}: ${route}`, "Selection matches intended range", expected);
    }
  }
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await fixture("Audit text\n"); await rich().getByText("Audit text", { exact: true }).click({ force: true }); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
    await command("delete-word", route); assert.ok(!(await sourceText()).includes("Audit"));
    pass(`Delete Word: ${route}`, "Word removed from actual source");
  }
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await rich().focus(); await command("source", route);
    await expect(page.locator(".document-editor:not([hidden]) .source-surface")).toBeVisible();
    await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("source").checked)).toBe(true);
    await command("source", route); await expect(rich()).toBeVisible();
    pass(`Source: ${route}`, "Source surface and native checked state follow toggle");
  }
  const imported = path.join(data, "import-source.docx");
  await fixture("# Audit\n\nAudit text\n");
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, imported);
  await command("docx");
  await expect.poll(() => readFile(imported).then(bytes => bytes.length, () => 0), { timeout: 60000 }).toBeGreaterThan(20);
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, imported);
  await command("import"); await expect(rich()).toContainText("Audit text");
  pass("Import DOCX", "Exported Word document imports as editable content");
  const workspace = path.join(data, "workspace");
  await mkdir(path.join(workspace, "destination"), { recursive: true });
  await writeFile(path.join(workspace, "context.md"), "# Context\n\nContext text\n", "utf8");
  await writeFile(path.join(workspace, "2.md"), "# Two\n", "utf8");
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(path.join(workspace, "10.md"), "# Ten\n", "utf8");
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
  await command("folder"); await command("files");
  await expect(page.getByRole("button", { name: "context.md", exact: true })).toBeVisible();
  pass("Open Folder", "Chosen directory populates file list");
  for (const [action, name] of [["new-file", "menu-created.md"], ["new-folder", "menu-created-folder"]]) {
    await command(action);
    await page.getByRole("dialog").getByLabel(t("文件名称"), { exact: true }).fill(name);
    await page.getByRole("dialog").getByRole("button", { name: t("确定"), exact: true }).click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (action === "new-folder") assert.ok((await stat(path.join(workspace, name))).isDirectory());
    else await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    pass(action, "File menu creates actual workspace entry");
  }
  async function context(name = "context.md") {
    await page.getByRole("button", { name, exact: true }).click({ button: "right", force: true });
    return page.getByRole("menu", { name: t("文件操作"), exact: true });
  }
  async function operation(label, name) {
    await (await context()).getByRole("menuitem", { name: t(label), exact: true }).click({ force: true });
    const dialog = page.getByRole("dialog");
    if (name) await dialog.getByLabel(t("文件名称"), { exact: true }).fill(name);
    await dialog.getByRole("button", { name: t("确定"), exact: true }).click({ force: true });
    await expect(dialog).toHaveCount(0);
  }
  for (const [label, name, contents] of [["新建文件…", "created.md", ""], ["创建副本…", "duplicate.md", "Context text"]]) {
    await operation(label, name);
    await expect.poll(() => readFile(path.join(workspace, name), "utf8").catch(() => null)).toContain(contents);
    pass(`Context: ${t(label)}`, "Requested file exists with correct content");
  }
  await operation("新建文件夹…", "created-folder");
  assert.ok((await stat(path.join(workspace, "created-folder"))).isDirectory());
  pass("Context: New Folder", "New directory appears in inventory");
  await (await context()).getByRole("menuitem", { name: t("复制路径"), exact: true }).click({ force: true });
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), path.join(workspace, "context.md"));
  pass("Context: Copy Path", "Clipboard contains actual absolute file path");
  await application.evaluate(({ shell }) => { shell.showItemInFolder = file => { globalThis.revealedAuditFile = file; }; });
  await (await context()).getByRole("menuitem", { name: t("在文件夹中显示"), exact: true }).click({ force: true });
  await expect.poll(() => application.evaluate(() => globalThis.revealedAuditFile)).toBe(path.join(workspace, "context.md"));
  pass("Context: Show in Folder", "Native shell receives actual file path", "Shell boundary verified; file manager UI unavailable in hidden run");
  await command("file-tree");
  for (const value of ["natural", "name", "modified", "created"]) {
    const popup = await context(); await popup.getByLabel(t("文件排序"), { exact: true }).selectOption(value);
    await expect(popup.getByLabel(t("文件排序"), { exact: true })).toHaveValue(value);
    const ordered = await page.getByRole("tree").locator("button.tree-entry").allTextContents();
    assert.equal(ordered.indexOf("2.md") < ordered.indexOf("10.md"), value !== "name");
    await page.keyboard.press("Escape");
    pass(`Context: Sort ${value}`, "Actual file order follows selected sorting rule");
  }
  await (await context()).getByLabel(t("文件排序"), { exact: true }).selectOption("natural"); await page.keyboard.press("Escape");
  for (const label of ["降序", "文件夹优先"]) {
    const popup = await context(), field = popup.getByLabel(t(label), { exact: true });
    const before = await field.isChecked(); await field.setChecked(!before, { force: true });
    await expect(field).toHaveAttribute("type", "checkbox");
    assert.equal(await field.isChecked(), !before); await page.keyboard.press("Escape");
    if (label === "降序") {
      const ordered = await page.getByRole("tree").locator("button.tree-entry").allTextContents();
      assert.ok(ordered.indexOf("10.md") < ordered.indexOf("2.md"));
      await (await context()).getByLabel(t(label), { exact: true }).uncheck({ force: true }); await page.keyboard.press("Escape");
    } else await expect(page.getByRole("tree").locator(":scope > [role=treeitem]").first()).not.toHaveAttribute("aria-expanded");
    pass(`Context: ${t(label)}`, "Actual file or folder order changes");
  }
  await operation("重命名…", "renamed.md");
  await expect.poll(() => readFile(path.join(workspace, "renamed.md"), "utf8").catch(() => "")).toContain("Context text");
  await command("undo-file");
  await expect.poll(() => readFile(path.join(workspace, "context.md"), "utf8").catch(() => "")).toContain("Context text");
  pass("Context Rename and File Undo", "Rename and undo change actual disk paths");
  await (await context()).getByRole("menuitem", { name: t("移动到…"), exact: true }).click({ force: true });
  await page.getByRole("dialog").getByLabel(t("目标文件夹"), { exact: true }).selectOption(path.join(workspace, "destination"));
  await page.getByRole("dialog").getByRole("button", { name: t("确定"), exact: true }).click({ force: true });
  await expect.poll(() => readFile(path.join(workspace, "destination", "context.md"), "utf8").catch(() => "")).toContain("Context text");
  await command("undo-file");
  await expect(page.getByRole("tree").locator(`[data-path=${JSON.stringify(path.join(workspace, "context.md"))}]`)).toHaveCount(1);
  pass("Context Move", "File reaches chosen directory and undo restores it");
  await operation("重命名…", "renamed.md");
  await (await context("renamed.md")).getByRole("menuitem", { name: t("撤销上次文件操作"), exact: true }).click({ force: true });
  await expect.poll(() => readFile(path.join(workspace, "context.md"), "utf8").catch(() => "")).toContain("Context text");
  pass("Context Undo", "Context menu restores renamed file");
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await (await context("duplicate.md")).getByRole("menuitem", { name: t("移到废纸篓"), exact: true }).click({ force: true });
  await expect.poll(() => readFile(path.join(workspace, "duplicate.md"), "utf8").then(() => true, () => false)).toBe(false);
  pass("Context Trash", "Trash removes actual file");
  await command("global-search", "shortcut");
  await page.getByRole("dialog").getByLabel(t("搜索文件夹内容"), { exact: true }).fill("Context text");
  await expect(page.locator(".global-search-results")).toContainText("context.md");
  await page.keyboard.press("Escape");
  pass("Folder Search", "Results contain actual matching file");
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await fixture("Audit text\n");
    await command("files");
    const name = await page.locator(".document-title").textContent();
    const count = await page.locator(".document-editor").count();
    const close = page.getByRole("button", { name: t("关闭 {{name}}", { name: name.trim() }), exact: true });
    await close.click({ force: true });
    await expect(close).toHaveCount(0);
    await expect(page.locator(".document-title")).not.toContainText(name.trim());
    await command("reopen", route); await expect(page.locator(".document-title")).toContainText(name.trim());
    await expect(page.locator(".document-editor")).toHaveCount(count);
    pass(`Reopen: ${route}`, "Closed document returns with its content");
  }
  for (const route of ["menu", "toolbar", "native"]) {
    const file = await fixture(`Recent document ${route}\n`);
    await command("files");
    const name = path.basename(file);
    const close = page.getByRole("button", { name: t("关闭 {{name}}", { name }), exact: true });
    await close.click({ force: true });
    await expect(close).toHaveCount(0);
    await expect(page.locator(".document-title")).not.toContainText(name);
    await command("recent", route);
    await page.getByRole("dialog").locator(".recent-open").filter({ hasText: file }).click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".document-title")).toContainText(name);
    await expect(rich()).toContainText(`Recent document ${route}`);
    pass(`Open Recent: ${route}`, "Recent entry reopens the actual closed document");
  }
  await fixture("Audit text\n");
  await command("statistics");
  const statistics = page.getByRole("dialog");
  await expect(statistics.locator("dd").nth(1)).toHaveText("2");
  for (const value of ["words", "characters"]) {
    await statistics.getByLabel(t("底部显示"), { exact: true }).selectOption(value);
    await expect(page.locator("#footer-word-count-label")).toContainText(value === "words" ? "2" : "9");
  }
  await page.keyboard.press("Escape");
  pass("Word and character counts", "Statistics and footer show actual document counts");
  for (const route of ["menu", "toolbar", "native"]) {
    const before = await page.locator("html").getAttribute("data-theme");
    await command("theme", route);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", before);
    pass(`Light/dark toggle: ${route}`, "Theme changes");
  }
  await menu("Omarkie", t("关于 Omarkie"));
  await expect(page.getByRole("dialog")).toContainText("0.1.2");
  await page.getByRole("button", { name: t("关闭关于"), exact: true }).click({ force: true });
  pass("About Omarkie", "About dialog displays application version");
  await application.evaluate(({ Menu, BrowserWindow }, label) => {
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === label);
    item.click(item, BrowserWindow.getAllWindows()[0]);
  }, t("关于 Omarkie"));
  await expect(page.getByRole("dialog")).toContainText("0.1.2");
  await page.getByRole("button", { name: t("关闭关于"), exact: true }).click({ force: true });
  pass("Native About Omarkie", "Native application menu opens actual About dialog");
  await command("preferences");
  const pandoc = await page.evaluate(async () => (await window.desktop.conversionSettings()).value.pandoc);
  if (pandoc) {
    chosenPandoc = path.join(data, "selected-pandoc"); await symlink(pandoc, chosenPandoc);
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, chosenPandoc);
    await preferences().getByRole("button", { name: t("选择 Pandoc…"), exact: true }).click({ force: true });
    await expect(preferences()).toContainText(chosenPandoc);
    pass("Choose Pandoc", "Chosen executable is detected and displayed");
  }
  await preferences().getByRole("button", { name: t("管理插件…"), exact: true }).click({ force: true });
  await expect(page.getByRole("dialog", { name: t("插件管理"), exact: true })).toBeVisible();
  for (const card of await page.locator(".plugin-card").all()) {
    const name = await card.locator("h3").textContent();
    const toggle = card.getByRole("checkbox"); await toggle.check({ force: true });
    await expect(card.locator(".plugin-toggle")).toContainText(t("已启用"));
    await expect(card.getByRole("alert")).toHaveCount(0);
    if (name === t("只读模式")) await expect(rich()).toHaveAttribute("contenteditable", "false");
    await toggle.uncheck({ force: true });
    await expect(card.locator(".plugin-toggle")).toContainText(t("未启用"));
    pass(`Plugin: ${name}`, "Bundled plugin starts and unloads without error");
  }
  await page.getByRole("dialog").getByRole("button", { name: t("安装本地插件…"), exact: true }).click({ force: true });
  const install = page.getByRole("button", { name: t("选择插件并安装…"), exact: true });
  await expect(install).toBeDisabled();
  await page.getByRole("checkbox", { name: t("我信任将要安装的插件源码"), exact: true }).check({ force: true });
  const plugin = path.join(data, "audit-plugin.js");
  await writeFile(plugin, 'class AuditPlugin extends BasePlugin { process() { this.utils.insertStyle("audit-menu", ".rich-document { --audit-plugin: active; }"); } } module.exports = { plugin: AuditPlugin };', "utf8");
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async (_window, options) => { globalThis.auditPluginDialogOptions = options; return { canceled: false, filePaths: [file] }; }; }, plugin);
  await install.click({ force: true });
  assert.deepEqual(await application.evaluate(() => globalThis.auditPluginDialogOptions.properties), ["openFile"]);
  await expect(page.locator(".plugin-card")).toHaveCount(9);
  const installed = page.locator(".plugin-card").last();
  await installed.getByRole("checkbox").check({ force: true });
  await expect.poll(() => rich().evaluate(element => getComputedStyle(element).getPropertyValue("--audit-plugin").trim())).toBe("active");
  await installed.getByRole("checkbox").uncheck({ force: true });
  await installed.getByRole("button", { name: t("移除插件"), exact: true }).click({ force: true });
  await expect(page.locator(".plugin-card")).toHaveCount(8);
  await page.keyboard.press("Tab"); await expect(page.getByRole("dialog").locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  pass("Install and remove local plugin", "Trust gate, installed stylesheet and removal work");
  const image = path.join(data, "audit image.png");
  const imageBytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#96abc1" } }).png().toBuffer();
  await writeFile(image, imageBytes);
  for (const route of ["menu", "toolbar", "native", "shortcut"]) {
    await fixture("Audit text\n"); await rich().focus();
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, image);
    await command("image", route);
    await expect(rich().locator("img")).toHaveCount(1);
    await rich().locator("img").evaluate(image => { image.loading = "eager"; });
    await expect.poll(() => rich().locator("img").evaluate(image => image.complete && image.naturalWidth)).toBe(16);
    const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-preferences")));
    const folder = settings.imageEscape ? settings.imageFolder.split("/").map(encodeURIComponent).join("/") : settings.imageFolder;
    assert.ok((await sourceText()).includes(`](${settings.imagePrefix ? "./" : ""}${folder}/`));
    pass(`Insert Image: ${route}`, "Selected file is copied and decoded in editor");
  }
  for (const action of ["copy-all-images", "move-all-images"]) {
    const output = path.join(data, action + ".png");
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await command(action);
    await expect.poll(() => readFile(output).then(bytes => bytes.equals(imageBytes), () => false)).toBe(true);
    await expect(rich().locator("img")).toHaveCount(1);
    await expect.poll(() => sourceText()).toContain(path.basename(output));
    if (action === "move-all-images") await expect.poll(() => readFile(path.join(data, "copy-all-images.png")).then(() => true, () => false)).toBe(false);
    pass(action, "Image bytes reach destination and document retains image");
  }
  let uploads = 0;
  uploader = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok((await readFile(value.list[0])).equals(imageBytes));
    uploads++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, result: ["https://example.invalid/audit-image.png"] }));
  });
  await new Promise(resolve => uploader.listen(0, "127.0.0.1", resolve));
  await command("preferences");
  await preferences().getByLabel(t("PicGo Server 地址"), { exact: true }).fill(`http://127.0.0.1:${uploader.address().port}/upload`);
  await preferences().getByRole("button", { name: t("完成"), exact: true }).click({ force: true });
  await command("upload-all-images");
  await expect.poll(() => uploads).toBe(1);
  await expect.poll(() => sourceText()).toContain("https://example.invalid/audit-image.png");
  pass("Upload All Images and PicGo address", "Loopback fixture receives actual image bytes and Markdown uses returned URL");
  await command("preferences");
  await preferences().getByLabel(t("插入后通过 PicGo 自动上传"), { exact: true }).check({ force: true });
  await preferences().getByRole("button", { name: t("完成"), exact: true }).click({ force: true });
  await fixture("Audit text\n");
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, image);
  await command("image");
  await expect.poll(() => uploads).toBe(2);
  await expect.poll(() => sourceText()).toContain("https://example.invalid/audit-image.png");
  await command("preferences");
  await preferences().getByLabel(t("插入后通过 PicGo 自动上传"), { exact: true }).uncheck({ force: true });
  await expect(preferences().getByLabel(t("显示远程图片"), { exact: true })).not.toBeChecked();
  await preferences().getByRole("button", { name: t("完成"), exact: true }).click({ force: true });
  pass("Automatic image upload", "Enabled insertion uploads to loopback fixture; network preferences restored off");
  for (const [code, title] of [["es", "Preferencias"], ["ca", "Preferències"], ["ro", "Preferințe"], ["zh", "偏好设置"], ["en", "Preferences"]]) {
    await rich().focus(); await command("preferences", "shortcut");
    await page.getByRole("dialog").getByRole("combobox").first().selectOption(code);
    await expect(page.locator("html")).toHaveAttribute("lang", code);
    await rich().focus(); await command("preferences", "shortcut");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("combobox").first()).toHaveValue(code);
    await page.keyboard.press("Escape");
    pass(`Language: ${code}`, "Interface reloads and persisted language is selected", title);
  }
  for (const route of ["menu", "native", "shortcut"]) {
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2 }); });
    const closed = application.waitForEvent("close");
    await command("close-window", route);
    await closed;
    pass(`Close Window: ${route}`, "Application window actually closes");
    await launch();
    if (chosenPandoc) {
      assert.equal(await page.evaluate(async () => (await window.desktop.conversionSettings()).value.pandoc), chosenPandoc);
      pass(`Pandoc selection persistence: ${route}`, "Chosen executable survives full application restart");
    }
  }
  for (const item of inventory.find(item => item.role === "windowmenu")?.submenu || []) checks.push({ item: `Native Window > ${item.label}`, expected: "Native window role changes window state", observed: "Native desktop window state is not independently verified by the isolated Ozone headless backend", result: "UNVERIFIABLE" });
  checks.push({ item: "Native Quit shortcut", expected: "Ctrl+Q quits through the native accelerator", observed: "Native accelerator dispatch is not independently verified by the isolated Ozone headless backend", result: "UNVERIFIABLE" });
  const closed = application.waitForEvent("close");
  await application.evaluate(({ Menu, BrowserWindow }, label) => {
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === label);
    item.click(item, BrowserWindow.getAllWindows()[0]);
  }, t("退出 Omarkie"));
  await closed; application = null;
  pass("Native Quit menu", "Application actually exits");
  if (process.argv.length === 2) {
    const visible = groups.flatMap(group => group.items).filter(item => !["newWindow", "newTab"].includes(item.action));
    assert.deepEqual(visible.filter(item => !invokedActions.has(item.action)).map(item => item.action), []);
    pass("Menu inventory coverage", "Every supported shared command was invoked in the built app", `${visible.length} supported commands; unsupported window/tab entries hidden`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(checks.filter(check => check.result === "FAIL"), []);
  completed = true;
} catch (error) {
  checks.push({ item: "Audit stopped", expected: "All remaining checks execute", observed: error.message, result: "FAIL" });
  throw error;
} finally {
  uploader?.close();
  await mkdir(qa, { recursive: true });
  await writeFile(path.join(qa, "menu-results.json"), JSON.stringify({ completed, checks, errors, inventory, invokedActions: [...invokedActions].sort() }, null, 2), "utf8");
  const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
  await writeFile(path.join(qa, "menu-results.md"), "| Item | Expected | Observed | PASS/FAIL |\n| --- | --- | --- | --- |\n" + checks.map(check => `| ${cell(check.item)} | ${cell(check.expected)} | ${cell(check.observed)} | ${check.result} |`).join("\n") + "\n", "utf8");
  console.log("Evidence: " + path.join(qa, "menu-results.json"));
  if (application) { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await application.close().catch(() => {}); }
}
