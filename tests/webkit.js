const passed = [],
  errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason)),
);
const wait = async (predicate, label = "Condition not reached", timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(label);
};
const check = (condition, label) => {
  if (!condition) throw new Error(label);
  passed.push(label);
  window.webkit.messageHandlers.omarkie.postMessage({
    id: "test-progress",
    name: "progress",
    args: [label],
  });
};
const root = () =>
  document.querySelector(".document-editor:not([hidden]) .rich-document");
const pointText = (value, offset) => {
  const walker = document.createTreeWalker(root(), NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.data.includes(value)) {
      root().focus();
      getSelection().setBaseAndExtent(
        node,
        node.data.indexOf(value) + offset,
        node,
        node.data.indexOf(value) + offset,
      );
      return;
    }
  }
  throw new Error("Missing editable text: " + value);
};
const input = (type, data = null) =>
  root().dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: type,
      data,
    }),
  );
const sourceMode = async (value) => {
  const button = document.querySelector(".source-toggle");
  if ((button.getAttribute("aria-pressed") === "true") !== value)
    button.click();
  await wait(() =>
    value
      ? !!document.querySelector(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-line")
      : !document.querySelector(".document-editor:not([hidden]) .rich-scroller[hidden]"),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
};
const readSource = () =>
  [
    ...document.querySelectorAll(
      ".document-editor:not([hidden]) .source-surface .cm-line",
    ),
  ]
    .map((node) => node.textContent)
    .join("\n");
try {
  await wait(() => root()?.querySelector("strong"));
  check(document.documentElement.lang === "en", "native fixture starts in English");
  const cleanInput = "# Clean fixture\n\npublisher artifact\n\nA reconst-\nruction.\n";
  const clean = await window.desktop.cleanConverted(cleanInput);
  check(clean.ok && clean.value === "# Clean fixture\n\nA reconst-\nruction.\n", "native Clean CLI processes a private copy");
  const documentId = "webkit-fixture";
  const store = request => window.desktop.readingStore(documentId, request);
  const block = { block: "This anchored sentence has enough words to survive a spelling edit.", headings: ["Synthetic fixture"], line: 4 };
  const note = await store({ action: "put", item: { type: "note", id: "native-note", body: "Native margin note.", anchor: { ...block, quote: "anchored sentence" } } });
  if (!note.ok) throw new Error(`Native margin note write failed: ${note.error}`);
  check(note.value.anchor.hash === "4c1f7343f2c05c4dca5e59fb2d75e1a0ef372c737c897f79419debe437aea2c0" && note.value.document === "WebKit-fixture.md", "native bridge creates a scoped and hashed margin note");
  const fuzzy = await store({ action: "resolve", blocks: [{ ...block, line: 11, block: block.block.replace("spelling", "speling") }] });
  const orphan = await store({ action: "resolve", blocks: [] });
  check(fuzzy.ok && fuzzy.value[0].line === 11 && orphan.ok && orphan.value[0].line === null, "native fuzzy reattachment and orphaning share the journal");
  const card = await store({ action: "put", item: { type: "card", id: "native-card", front: "Synthetic question", back: "Synthetic answer" } });
  const answer = await store({ action: "put", owner: "WebKit-fixture.md", item: { type: "answer", id: "native-answer", cardId: "native-card", rating: 5 } });
  const review = await store({ action: "list", scope: "vault", types: ["card", "answer"] });
  check(card.ok && answer.ok && review.ok && review.value[0].back === "Synthetic answer" && review.value[1].rating === 5, "native card and rating share one vault journal");
  const unknown = await window.desktop.readingStore("unknown-document", { action: "list", scope: "vault" });
  check(!unknown.ok, "native reading store rejects an unregistered document");
  const initialSession = (await window.desktop.restore()).value;
  const vault = initialSession.folder;
  const renamed = await window.desktop.fileOperation({ action: "rename", path: `${vault}/WebKit-fixture.md`, name: "WebKit-renamed.md" });
  const movedEntries = await store({ action: "list" });
  check(renamed.ok && movedEntries.ok && movedEntries.value.length === 3 && movedEntries.value.every(item => item.document === "WebKit-renamed.md"), "native rename carries the note, card and rating");
  const undone = await window.desktop.fileOperation({ action: "undo" });
  const restoredEntries = await store({ action: "list" });
  check(undone.ok && restoredEntries.ok && restoredEntries.value.length === 3 && restoredEntries.value.every(item => item.document === "WebKit-fixture.md"), "native rename undo restores the reading paths");
  const payload = { baseUrl: payloadBaseURL, confirmedOrigin: new URL(payloadBaseURL).origin, model: "native-fixture", source: "Synthetic source paragraph." };
  const rejected = await window.desktop.payloadRequest({ ...payload, confirmedOrigin: "https://example.invalid" });
  check(!rejected.ok, "native Payload rejects an unconfirmed origin");
  const summary = await window.desktop.payloadRequest(payload);
  const followUp = await window.desktop.payloadRequest({ ...payload, question: "What is this?", modernLimit: true });
  const under = await window.desktop.payloadRequest({ ...payload, model: "fixture-under" });
  const over = await window.desktop.payloadRequest({ ...payload, model: "fixture-over" });
  const failed = await window.desktop.payloadRequest({ ...payload, model: "fixture-status" });
  const overhead = JSON.stringify({ choices: [{ message: { content: "" } }] }).length;
  check(under.ok && under.value === "x".repeat(63999 - overhead) && !over.ok && !failed.ok, "native Payload accepts only a valid in-limit 2xx completion");
  const remotePreference = async enabled => {
    window.__omarkie.command({ action: "preferences" });
    const checkbox = () => document.querySelector('input[name="remoteImages"]');
    const field = await wait(checkbox, `Remote media preference did not appear (enabled=${enabled})`);
    if (field.checked !== enabled) field.click();
    document.querySelector('.dialog-heading button').click();
  };
  const policy = await window.desktop.setRemoteImages(false);
  check(policy.ok && policy.value, "native editor starts the local image check with remote media blocked");
  const image = (container, alt) => container?.querySelector(`img[alt="${alt}"]`);
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgaGAAAAEEAIEl6+oTAAAAAElFTkSuQmCC";
  const blobURL = URL.createObjectURL(new Blob([Uint8Array.from(atob(pixel), c => c.charCodeAt(0))], { type: "image/png" }));
  const dataURL = `data:image/png;base64,${pixel}`;
  const decoded = (img, url, width, height) => img?.currentSrc === url && img.naturalWidth === width && img.naturalHeight === height;
  const probe = async (phase, name, container) => {
    const img = new Image();
    let loaded;
    img.onload = () => { loaded = true; };
    img.onerror = () => { loaded = false; };
    try {
      container.append(img);
      img.src = `${grammarOrigin}/reader-media-${phase}-${name}`;
      await wait(() => loaded !== undefined, `${phase}: media probe ${name} did not settle`);
      return loaded;
    } finally { img.remove(); }
  };
  const assetFor = record => name => `omarkie-asset://local/${encodeURIComponent(record.id)}/${encodeURIComponent(name)}`;
  const openMediaToken = async phase => {
    const scanned = await window.desktop.scan();
    if (!scanned.ok) throw new Error(scanned.error);
    const file = scanned.value.files.find(file => file.relative === `preview-media/Media-${phase}.md`);
    if (!file) throw new Error(`${phase}: missing saved vault note`);
    const opened = await window.desktop.openToken(file.token);
    if (!opened.ok) throw new Error(`${phase}: could not open media fixture: ${opened.error}`);
    return opened.value;
  };
  const openMedia = async phase => {
    const route = `/reader-media-${phase}-control`;
    const record = await openMediaToken(phase);
    const asset = assetFor(record);
    if (phase === "reading") {
      const stale = await window.desktop.persist(initialSession);
      if (!stale.ok) throw new Error(`Could not persist the preceding tab snapshot: ${stale.error}`);
      const local = await window.desktop.readResource(asset("local.svg"));
      check(local.ok && local.value.mime === "image/svg+xml", "native asset grant survives a session snapshot taken before the note opened");
    }
    const content = record.content + `\n<div><img alt="Preview image" src="fallback.svg" srcset="${grammarOrigin}${route} 1x, fallback.svg 1x"><video poster="${grammarOrigin.replace("http:", "h&#9;ttp:")}/reader-media-${phase}-poster"></video><video poster="${blobURL}"></video><img alt="HTML blob" src="${blobURL}"><img alt="Data image" src="${dataURL}"></div>\n\n![Markdown blob](${blobURL})\n`;
    window.__omarkie.command({ action: "opened", document: { ...record, content, savedContent: content } });
    await wait(() => decoded(image(root(), "Local image"), asset("local.svg"), 11, 17), `${phase}: editing did not decode the saved note's local image`);
    if (phase === "reading") {
      check(!await probe(phase, "editor-blocked", root()), "native offline editor blocks the loopback image");
      await remotePreference(true);
    }
    await wait(() => decoded(image(root(), "Preview image"), `${grammarOrigin}${route}`, 1, 1), `${phase}: opted-in editing did not decode remote media`);
    if (phase === "reading") check(await probe(phase, "editor-allowed", root()), "native opted-in editor loads the loopback image");
    check(await probe(phase, "offline-start", document.body), `${phase}: offline cutover could not confirm the editing poster request`);
    return record;
  };
  const assertOffline = async (phase, container, asset) => {
    for (const [alt, url, width, height] of [
      ["Local image", asset("local.svg"), 11, 17],
      ["Preview image", asset("fallback.svg"), 11, 17],
      ["HTML blob", blobURL, 1, 1], ["Data image", dataURL, 1, 1], ["Markdown blob", blobURL, 1, 1],
    ]) await wait(() => {
      const preview = container();
      const alert = preview?.querySelector("[role=alert]");
      if (alert) throw new Error(`${phase}: ${alert.textContent}`);
      return decoded(image(preview, alt), url, width, height);
    }, `${phase}: ${alt} did not decode in preview`);
    const preview = container(), video = preview.querySelector("video"), fallback = image(preview, "Preview image");
    check(fallback.getAttribute("srcset") === `${asset("fallback.svg")} 1x` && video && !video.hasAttribute("poster"), `${phase}: preview keeps the local candidate and strips remote media`);
    check(preview.querySelectorAll("video")[1]?.getAttribute("poster") === blobURL, `${phase}: preview keeps the local video poster`);
    check([null, "11"].includes(fallback.getAttribute("width")) && [null, "17"].includes(fallback.getAttribute("height")), `${phase}: remote candidate dimensions do not size the local fallback`);
    check(!await probe(phase, "offline-probe", preview), `${phase}: native policy blocks remote preview requests`);
  };
  const closeMedia = async (phase, asset) => {
    window.__omarkie.command({ action: "close" });
    await wait(() => document.querySelector('.document-title')?.title === 'WebKit-fixture.md', `${phase}: media note did not close`);
    check(!(await window.desktop.readResource(asset("local.svg"))).ok, `${phase}: closing the tab revokes its asset grant`);
  };
  const readingRecord = await openMedia("reading");
  const readingAsset = assetFor(readingRecord);
  const readingToggle = await wait(() => document.querySelector('[data-testid="reading-layers-toggle"]:enabled'), "Reading Layers toggle did not become enabled");
  readingToggle.click();
  await wait(() => document.querySelector(".layers-rail"), "Reading Layers rail did not open");
  await assertOffline("reading", root, readingAsset);
  await closeMedia("reading", readingAsset);
  const readingClose = await wait(() => document.querySelector('[data-testid="reading-layers-close"]'), "Reading Layers close button did not mount");
  readingClose.click();
  await wait(() => !document.querySelector(".layers-rail") && document.querySelector('[data-testid="reading-layers-toggle"][aria-pressed=false]'), "Reading Layers did not close before Clean");
  const reopenedFromTree = await openMediaToken("reading");
  check(reopenedFromTree.id !== readingRecord.id, "file tree open issues a fresh grant after close");
  window.__omarkie.command({ action: "opened", document: reopenedFromTree });
  await wait(() => decoded(image(root(), "Local image"), assetFor(reopenedFromTree)("local.svg"), 11, 17), "file tree open did not decode the local image");
  const reopenedFromHistory = await window.desktop.reopen(readingRecord.id);
  await closeMedia("reopened reading", assetFor(reopenedFromTree));
  check(reopenedFromHistory.ok && reopenedFromHistory.value.id === reopenedFromTree.id &&
    !(await window.desktop.readResource(readingAsset("local.svg"))).ok,
    "reopen reuses the live tab and closing it leaves neither grant readable");
  const cleanAsset = assetFor(await openMedia("clean"));
  window.__omarkie.command({ action: "clean-converted" });
  const cleanLayer = () => document.querySelector(".clean-layer");
  await wait(cleanLayer, "Clean preview did not open");
  await assertOffline("clean", cleanLayer, cleanAsset);
  await closeMedia("clean", cleanAsset);
  URL.revokeObjectURL(blobURL);
  window.__omarkie.command({ action: "document-tools" });
  const writingTab = await wait(() => document.querySelector('.workflow-tabs [data-tab="writing"]:enabled'), "Document Tools writing tab did not become enabled");
  writingTab.click();
  const exportPdf = await wait(() => document.querySelector('[data-testid="project-export-pdf"]:enabled'), "Project PDF export button did not become enabled");
  exportPdf.click();
  await wait(() => {
    if (exportPdf.disabled) return false;
    const message = document.querySelector('.utility-dialog [role="alert"]')?.textContent;
    if (!message) return false;
    if (message !== "PDF exported.") throw new Error(`Project PDF export: ${message}`);
    return true;
  }, "Project PDF export did not finish after diagram preparation, conversion and rendering", 75000);
  check(true, "native UI project PDF export completes");
  document.querySelector('.dialog-heading button').click();
  await remotePreference(false);
  check(summary.ok && followUp.ok && summary.value === "Synthetic summary." && followUp.value === "Synthetic follow-up answer.", "native Payload returns the response to each explicit request");
  const sizes = await window.desktop.imageSizes(documentId, ["Background-fixture.png", "https://example.invalid/foreign.png"]);
  check(sizes.ok && sizes.value["Background-fixture.png"]?.join("x") === "1x1" && Object.keys(sizes.value).length === 1, "native original dimensions are scoped to owned images");
  const grammar = await window.desktop.checkGrammar(`${grammarOrigin}/v2/check`, "", "A😀 + &?");
  const redirected = await window.desktop.checkGrammar(`${grammarOrigin}/redirect/v2/check`, "", "A😀 + &?");
  const insecure = await window.desktop.checkGrammar("http://example.invalid/v2/check", "", "Never send.");
  check(grammar.ok && grammar.value.matches[0].message === "Synthetic finding" && !redirected.ok && !insecure.ok, "native Grammar uses bounded approved transport without redirects");
  const stopped = await window.desktop.readAloud(null);
  const text = "Native café $(literal) speech.😀".padEnd(256_000, "x");
  const spoken = await window.desktop.readAloud(text);
  const tooLong = await window.desktop.readAloud(text + "x");
  check(stopped.ok && spoken.ok && !tooLong.ok, "native speech accepts 256,000 UTF-16 units and rejects 256,001");
  const linked = await window.desktop.bibliography(vault, "link");
  const suggestions = await window.desktop.bibliography(vault, "suggest", "wat");
  const authorSuggestions = await window.desktop.bibliography(vault, "suggest", "Garci\u0301a");
  check(authorSuggestions.ok && authorSuggestions.value[0]?.id === "watched", "native citation suggestions find Unicode authors");
  const wrongVault = await window.desktop.bibliography(`${vault}/unopened`, "info");
  check(linked.ok && linked.value && suggestions.ok && suggestions.value[0].id === "watched" && !wrongVault.ok, "native bridge authorizes only the open bibliography vault");
  const citeOptions = { bibliography: (await window.desktop.bibliography(vault, "info")).value.csl, style: "vancouver" };
  const chapters = ["# First native chapter\n\nSource [@watched].\n", "# Second native chapter\n\nAgain [@watched].\n"];
  const outside = await window.desktop.exportConverted({ folder: `${vault}/unknown` }, "docx", chapters, "", citeOptions);
  check(!outside.ok, "native bridge rejects project export from an unknown vault");
  const projectDocx = await window.desktop.exportConverted({ folder: vault }, "docx", chapters, "", citeOptions);
  if (!projectDocx.ok) throw new Error(`Native cited project DOCX: ${projectDocx.error}`);
  const media = `<video preload="auto" src="${grammarOrigin}/project-export-media"></video>`;
  const projectPdf = await window.desktop.exportConverted({ folder: vault }, "pdf", [chapters[0] + "\n" + media, chapters[1]], "", citeOptions);
  if (!projectPdf.ok) throw new Error(`Native cited project PDF: ${projectPdf.error}`);
  check(true, "native bridge exports cited project DOCX and PDF");
  check(
    location.protocol === "omarkie:" && window.desktop !== undefined,
    "bundled modules load through native WebKit scheme and bridge",
  );
  const originalResponse = await window.desktop.restore();
  if (!originalResponse.ok) throw new Error(originalResponse.error);
  const original = originalResponse.value.documents[0].content;
  const openPreferences = async () => { window.__omarkie.command({action:"preferences"}); await wait(() => document.querySelector('.background-settings')); };
  const chooseBackground = () => document.querySelector('.background-file button:first-of-type').click();
  await openPreferences(); chooseBackground();
  await wait(() => document.querySelector('.editor-background'));
  check((await window.desktop.background()).value.name === 'Background-fixture.png','native background picker persists the managed image');
  const setRange = (index,value) => { const field = document.querySelectorAll('.background-controls input[type="range"]')[index]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,String(value)); field.dispatchEvent(new Event('input',{bubbles:true})); };
  setRange(0,42); setRange(1,7);
  await wait(() => getComputedStyle(document.querySelector('.editor-background')).opacity === '0.42');
  check(getComputedStyle(document.querySelector('.editor-background')).filter === 'blur(7px)','background controls change the image layer without dimming text');
  document.querySelector('.background-reset').click();
  await wait(() => getComputedStyle(document.querySelector('.editor-background')).opacity === '0.18');
  check(getComputedStyle(document.querySelector('.editor-background')).filter === 'blur(0px)','reset restores subtle background defaults');
  document.querySelector('.background-file button:nth-of-type(2)').click(); await wait(() => !document.querySelector('.editor-background'));
  check((await window.desktop.background()).value === null,'clear background updates native persistence');
  chooseBackground(); await wait(() => document.querySelector('.editor-background'));
  document.querySelector('.dialog-heading button').click();
  await sourceMode(true);
  check(getComputedStyle(document.querySelector('.source-surface .cm-editor')).backgroundColor === 'rgba(0, 0, 0, 0)' && readSource() === original,'background remains visible in source mode without changing Markdown');
  await sourceMode(false);
  await wait(() => root().querySelectorAll(".mathjax-node svg").length === 2);
  check(
    !root().querySelector(".math-error,[data-mjx-error]"),
    "offline MathJax SVG renders document macros and extended fonts",
  );
  const openPlugins = async () => { window.__omarkie.command({action:"plugins"}); await wait(() => document.querySelector('.plugin-list')); };
  const pluginCard = (name, id) => id ? document.querySelector(`.plugin-card[data-plugin-id="${id}"]`) : [...document.querySelectorAll('.plugin-card')].find(card => card.querySelector('h3')?.textContent === name);
  const closePlugins = () => document.querySelector('.dialog-heading button').click();
  pointText("粗体", 1);
  await openPlugins();
  await wait(() => pluginCard('Native-plugin-fixture'));
  pluginCard('Native-plugin-fixture').querySelector('input[type="checkbox"]').click();
  await wait(() => getComputedStyle(root()).getPropertyValue('--plugin-fixture').trim() === 'loaded');
  check(true, 'installed CommonJS plugin is dynamically imported by native WebKit under the existing CSP');
  pluginCard('Native-plugin-fixture').querySelector('.plugin-actions button').click();
  closePlugins(); await wait(() => root().textContent.includes('粗插件体'));
  check(true, 'installed original plugin calls the document adapter and creates a real undoable edit');
  window.__omarkie.command({action:'undo'}); check(!root().textContent.includes('插件'), 'plugin edits undo without changing surrounding Markdown');
  await openPlugins(); pluginCard('Native-plugin-fixture').querySelector('input[type="checkbox"]').click(); await wait(() => !document.querySelector('style[data-plugin^="local-"]'));
  check(true, 'disabling an installed plugin removes its styles');
  await wait(()=>pluginCard('Package fixture'));
  pluginCard('Package fixture').querySelector('input[type="checkbox"]').click();
  await wait(()=>window.packageProbe?.ticks>0 && getComputedStyle(root()).getPropertyValue('--package-fixture').trim()==='loaded');
  check(window.packageProbe.cached && window.packageProbe.marker==='/*__ENTRY__*/ /*__MODULES__*/','native folder modules resolve JS JSON CSS and cache shared dependencies under the existing CSP');
  pluginCard('Package fixture').querySelector('.plugin-actions button').click();closePlugins();
  await wait(()=>root().textContent.includes('插件中文😀42'));
  window.__omarkie.command({action:'undo'});check(!root().textContent.includes('插件中文'),'native package command produces a single undoable Unicode edit');
  await openPlugins();pluginCard('Package fixture').querySelector('input[type="checkbox"]').click();
  await wait(()=>!document.querySelector('style[data-plugin^="local-"]'));
  const stoppedTicks=window.packageProbe.ticks;await new Promise(resolve=>setTimeout(resolve,100));
  check(window.packageProbe.ticks===stoppedTicks,'native installed plugin timers stop when disabled');
  for (const id of ['collapse_list','read_only','no_image','blur','static_markers','dark']) {
    const card = pluginCard(null, id);
    card.querySelector('input[type="checkbox"]').click();
    await wait(() => !pluginCard(null, id).querySelector('.plugin-actions button').disabled);
    check(!card.querySelector('[role="alert"]'), 'upstream ' + id + ' plugin runs in native WebKit');
    if (id === 'collapse_list') {
      card.querySelector('.plugin-actions button:last-of-type').click();
      const command=()=>pluginCard(null, id).querySelector('button[aria-pressed]');
      await wait(()=>command() || card.querySelector('[role="alert"]')).catch(()=>{throw new Error('Missing plugin command: '+card.textContent);});
      if (!command()) throw new Error('Missing plugin action: '+card.textContent);
      check(command()?.getAttribute('aria-pressed')==='true','upstream dynamic command is visible with its checked state');
      command().click(); await wait(()=>command()?.getAttribute('aria-pressed')==='false');
      check(true,'plugin command calls the original plugin and persists the changed setting');
    }
    if (id === 'read_only') {
      closePlugins(); pointText('粗体', 1); input('insertText','BLOCKED');
      check(!root().textContent.includes('BLOCKED') && root().getAttribute('aria-readonly') === 'true', 'read-only plugin blocks real editor input events');
      await sourceMode(true); check(document.querySelector('.document-editor:not([hidden]) .cm-content').getAttribute('contenteditable') === 'false', 'read-only plugin also locks source mode');
      await sourceMode(false); await openPlugins();
    }
    if (id === 'static_markers') check(getComputedStyle(root().querySelector('[data-mark="em"] .md-meta')).display === 'inline', 'static markers plugin changes rendered inline metadata');
    if (id === 'dark') check(document.documentElement.classList.contains('plugin-dark'), 'dark plugin applies its original root class');
    pluginCard(null, id).querySelector('input[type="checkbox"]').click();
    await wait(() => !document.querySelector('style[data-plugin="'+id+'"]'));
  }
  check(!document.documentElement.classList.contains('plugin-dark') && root().getAttribute('aria-readonly') === 'false', 'plugin teardown restores editing and removes presentation effects');
  closePlugins();
  for (const [needle, offset] of [["粗体",1],["任务",1],["B",1]]) {
    pointText(needle,offset);
    const node=getSelection().anchorNode, before=node.data, at=getSelection().anchorOffset;
    node.parentElement.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    node.data=before.slice(0,at)+'nihao'+before.slice(at);
    const target=node.parentElement;
    target.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你好'}));
    await Promise.resolve();
    node.data=before.slice(0,at)+'你好'+before.slice(at); getSelection().collapse(node,at+2);
    target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'你好'}));
    await new Promise(resolve=>setTimeout(resolve,20));
    await sourceMode(true);
    check(readSource()===original.replace(needle,needle.slice(0,offset)+'你好'+needle.slice(offset)), 'WebKit delayed Chinese commit preserves '+needle+' and its Markdown container');
    await sourceMode(false); window.__omarkie.command({action:'undo'});
    await sourceMode(true); check(readSource()===original,'WebKit Chinese commit undoes once for '+needle); await sourceMode(false);
  }
  pointText("。", 1);
  input("insertParagraph");
  const emptyLeaf = [...root().querySelectorAll("[data-leaf]")].find(element => !element.textContent);
  check(emptyLeaf && getSelection().anchorNode === emptyLeaf, "new paragraph uses an element caret in native WebKit");
  emptyLeaf.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  emptyLeaf.textContent = "你好";
  getSelection().collapse(emptyLeaf.firstChild, 2);
  emptyLeaf.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText", data: "你好" }));
  emptyLeaf.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
  await sourceMode(true);
  check(readSource() === original.replace("。", "。\n\n你好"), "synthetic composition at an empty element persists exact Chinese in native WebKit");
  await sourceMode(false);
  window.__omarkie.command({ action: "undo" });
  check(!root().textContent.includes("你好"), "empty-paragraph composition undoes as one transaction");
  window.__omarkie.command({ action: "redo" });
  check(root().textContent.includes("你好"), "empty-paragraph composition redoes as one transaction");
  window.__omarkie.command({ action: "undo" });
  window.__omarkie.command({ action: "undo" });
  await sourceMode(true);
  check(readSource() === original, "composition regression restores the original fixture exactly");
  await sourceMode(false);
  const repeatedSource='# 重复输入\n\n同\n\n同\n', repeatedRecord={id:'repeat-ime',path:null,name:'Repeated-IME.md',content:repeatedSource,savedContent:repeatedSource,diskHash:null,lineEnding:'\n'};
  const repeatedRegistration=await window.desktop.registerDraft(repeatedRecord);if(!repeatedRegistration.ok)throw Error(repeatedRegistration.error);
  window.__omarkie.command({action:'opened',document:repeatedRecord});await wait(()=>document.querySelector('.document-title')?.textContent==='Repeated-IME.md');
  for(const candidate of ['同','同同','中文😀']) {
    const [first,second]=root().querySelectorAll(':scope > p');root().focus();getSelection().setBaseAndExtent(first.firstChild,0,second.firstChild,1);
    first.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));first.textContent=candidate;second.remove();getSelection().collapse(first.firstChild,candidate.length);
    first.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:candidate}));
    await sourceMode(true);check(readSource()==='# 重复输入\n\n'+candidate+'\n','native repeated-text composition replaces the selected paragraph boundaries: '+candidate);
    await sourceMode(false);window.__omarkie.command({action:'undo'});await sourceMode(true);check(readSource()===repeatedSource,'native repeated-text composition undoes once: '+candidate);await sourceMode(false);
  }
  window.__omarkie.command({action:'opened',document:originalResponse.value.documents[0]});await wait(()=>document.querySelector('.document-title')?.textContent==='WebKit-fixture.md');
  pointText("粗体", 1);
  document.dispatchEvent(new Event("selectionchange"));
  check(
    root()
      .querySelector('[data-mark="strong"]')
      .classList.contains("md-expand") &&
      !root().querySelector('[data-mark="em"]').classList.contains("md-expand"),
    "only the inline containing the collapsed caret expands",
  );
  input("insertText", "测");
  await sourceMode(true);
  check(
    readSource() === original.replace("粗体", "粗测体"),
    "rich DOM edit produces exact Markdown in separate source view",
  );
  window.__omarkie.command({ action: "undo" });
  await wait(() => readSource() === original);
  check(readSource() === original, "source undo restores the original rich edit bytes");
  window.__omarkie.command({ action: "redo" });
  await wait(() => readSource() === original.replace("粗体", "粗测体"));
  check(readSource() === original.replace("粗体", "粗测体"), "source redo restores the exact rich edit");
  await sourceMode(false);
  window.__omarkie.command({ action: "undo" });
  await sourceMode(true);
  check(readSource() === original, "rich undo shares history after source undo and redo");
  await sourceMode(false);
  window.__omarkie.command({ action: "redo" });
  await sourceMode(true);
  check(readSource() === original.replace("粗体", "粗测体"), "rich redo restores the exact edit across both views");
  await sourceMode(false);
  pointText("粗测体", 2);
  input("insertText", "新");
  const untouched = root().querySelector("h1");
  pointText("任务", 2);
  input("insertParagraph");
  input("insertText", "后续");
  check(
    root().querySelector("h1") === untouched,
    "an unaffected block keeps its actual DOM node across structural edits",
  );
  const checkbox = root().querySelector('input[type="checkbox"]');
  checkbox.click();
  await sourceMode(true);
  check(
    readSource().includes("- [x] 任务\n- [ ] 后续"),
    "task toggle and Enter keep task-list structure",
  );
  await sourceMode(false);
  const png = Uint8Array.from(
    atob(
      pixel,
    ),
    (char) => char.charCodeAt(0),
  );
  const imported = await window.desktop.importImage(
    "webkit-fixture",
    png,
    "fixture.png",
  );
  if (!imported.ok) throw new Error(imported.error);
  const uploadedImage = await window.desktop.imageAction("webkit-fixture", [imported.value], "upload", {imageUploader:uploaderURL});
  if (!uploadedImage.ok) throw new Error(uploadedImage.error);
  check(uploadedImage.value[imported.value] === "https://images.example.invalid/owned-fixture.png", "native PicGo upload validates the response from an owned local HTTP server");
  pointText("WebKit 验收", 9);
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "\n\n![验收](" + imported.value + ")\n\n");
  root().dispatchEvent(
    new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }),
  );
  await wait(() => root().querySelector("img")?.naturalWidth === 1);
  check(
    true,
    "native scoped image scheme resolves an encoded relative asset path",
  );
  await sourceMode(true);
  const source = readSource();
  const saved = await window.desktop.save(
    "webkit-fixture",
    source,
    false,
    false,
  );
  if (!saved.ok) throw new Error(saved.error);
  check(
    saved.value.content === source,
    "native save bridge returns the exact source content",
  );
  const renamedFile = await window.desktop.fileOperation({action:'rename', path:saved.value.path, name:'Renamed-fixture.md'});
  if (!renamedFile.ok) throw new Error(renamedFile.error);
  await wait(() => document.querySelector('.document-title')?.textContent.includes('Renamed-fixture.md'));
  const undoneFile = await window.desktop.fileOperation({action:'undo'});
  if (!undoneFile.ok) throw new Error(undoneFile.error);
  await wait(() => document.querySelector('.document-title')?.textContent.includes('WebKit-fixture.md'));
  check(readSource() === source, "native file operation preparation, path synchronization and undo preserve exact editor bytes");
  window.__omarkie.command({ action: "pdf" });
  await wait(() =>
    document.querySelector(".toast")?.textContent.includes("PDF exported"),
  );
  check(
    true,
    "native PDF export completes asynchronously without blocking the editor",
  );
  const longHtml = '<!doctype html><html><head><style>html,body{margin:0;padding:0}.print-document{display:flow-root;font:14px/24px sans-serif}h2{margin:20px 0 8px}table{width:100%;border-collapse:collapse}td{padding:10px;border:1px solid #ccc}p{margin:0 0 16px}</style></head><body><article class="print-document"><h1>Pagination fixture</h1>' + Array.from({length:90}, (_, i) => '<h2>Heading-' + String(i+1).padStart(3,'0') + '</h2><p>Paragraph-' + String(i+1).padStart(3,'0') + ' keeps each complete line on a page.</p>').join('') + '<table>' + Array.from({length:30}, (_, i) => '<tr><td>Row-' + String(i+1).padStart(3,'0') + '</td><td>Complete table cell</td></tr>').join('') + '</table></article></body></html>';
  const longPdf = await window.desktop.exportPdf(longHtml, {testName:'long', paper:'letter', margin:42, title:'Pagination fixture', header:'${title}', footer:'${pageNo} / ${totalPages}'});
  if (!longPdf.ok) throw new Error(longPdf.error);
  check(true, "long PDF uses configurable paper, margins, headers and line-aware page boundaries");
  const marginPdf = await window.desktop.exportPdf('<!doctype html><html><head><style>html,body{margin:0;padding:0}.print-document{display:flow-root}p{margin:0 0 800px;font:16px/24px sans-serif}</style></head><body><article class="print-document"><p>Trailing margin regression</p></article></body></html>');
  if (!marginPdf.ok) throw new Error(marginPdf.error);
  check(true, "native PDF ignores an unpainted trailing block margin");
  window.__omarkie.command({ action: "html" });
  await wait(() => document.querySelector(".toast")?.textContent.includes("HTML exported"));
  check(true, "native HTML export embeds local fonts and images without live app links");
  window.webkit.messageHandlers.omarkie.postMessage({id:"phase",name:"progress",args:["phase: encoding dialog"]});
  // Drive the new encoding dialog through its real native bridge and byte writer.
  for (const encoding of ['gb18030', 'utf-16be', 'utf-8']) {
    document.querySelector('[data-testid="text-encoding"]').click(); await wait(() => document.querySelector('[role="dialog"] select'));
    const select = document.querySelector('[role="dialog"] select'); select.value = encoding; select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('[role="dialog"] .dialog-actions .primary-button').click();
    await wait(() => !document.querySelector('[role="dialog"]'));
    check(document.querySelector('[data-testid="text-encoding"]').textContent.includes(({gb18030:"GB18030", "utf-16be":"UTF-16 BE", "utf-8":"UTF-8"})[encoding]), 'native encoding dialog converts and updates metadata: ' + encoding);
  }
  window.webkit.messageHandlers.omarkie.postMessage({id:"phase",name:"progress",args:["phase: complex source mode"]});
  await sourceMode(false);
  window.webkit.messageHandlers.omarkie.postMessage({id:"phase",name:"progress",args:["phase: complex canvas"]});
  const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 120; const context = canvas.getContext('2d'); context.fillStyle = '#eef3f8'; context.fillRect(0, 0, 360, 120); context.fillStyle = '#375576'; context.fillRect(20, 20, 80, 80); context.font = '22px sans-serif'; context.fillText('中文图片验收', 120, 68);
  const complexImage = await window.desktop.importImage('webkit-fixture', Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0)), 'complex.png'); if (!complexImage.ok) throw new Error(complexImage.error);
  const imagePath = saved.value.path.slice(0, saved.value.path.lastIndexOf("/") + 1) + complexImage.value;
  const complexSource = '# 复杂中文文档\n\n## 结构与内容\n\n中文段落 **粗体**、*斜体*、[参考链接](https://example.com/document)。\n\n1. 一级列表\n   - 嵌套子项\n   - 第二子项\n2. 第二项\n\n| 项目 | 数量 | 说明 |\n| :--- | ---: | :---: |\n| 中文甲 | 12 | 单元格内容 |\n| 中文乙 | 34 | 第二行 |\n\n脚注引用[^note]。\n\n[^note]: 中文脚注内容。\n\n行内公式 $E=mc^2$。\n\n$$\n\\int_0^1 x^2 \\,dx=\\frac{1}{3}\n$$\n\n![中文图片](<' + imagePath + '>)\n\n<img src="' + imagePath + '" alt="带尺寸图片" width="120" />\n\n![引用图片][figure]\n\n[figure]: <' + imagePath + '>\n\n```mermaid\nflowchart LR\n  A[中文开始] --> B[检查完成]\n```\n\n```sequence\nAlice->Bob: Native conversion\nBob-->Alice: Complete\n```\n\n```flow\nst=>start: Start\ne=>end: End\nst->e\n```\n\n```javascript\nconst message = "中文代码";\n```\n';
  const complexRecord = { id: 'complex-fixture', path: null, name: '复杂中文文档.md', content: complexSource, savedContent: '', diskHash: null, lineEnding: '\n' };
  window.webkit.messageHandlers.omarkie.postMessage({id:"phase",name:"progress",args:["phase: complex register"]});
  const complexRegistered = await window.desktop.registerDraft(complexRecord); if (!complexRegistered.ok) throw new Error(complexRegistered.error);
  window.__omarkie.command({ action: 'opened', document: complexRecord });
  await wait(() => document.querySelector('.document-title')?.textContent.startsWith(complexRecord.name));
  window.webkit.messageHandlers.omarkie.postMessage({id:"phase",name:"progress",args:["phase: complex diagram"]});
  await wait(() => root()?.querySelectorAll('.mermaid-block svg').length === 3);
  check(true, 'complex Chinese fixture renders nested lists, tables, images, footnotes, math and Mermaid');
  window.__omarkie.command({ action: 'pdf' }); await wait(() => document.querySelector('.toast')?.textContent.includes('PDF exported'));
  check(true, 'complex native PDF export includes rendered Chinese tables, math, images, diagrams and footnotes');
  for (const format of ['docx', 'odt', 'rtf', 'epub', 'latex', 'rst', 'mediawiki', 'textile', 'opml', 'revealjs']) {
    window.__omarkie.command({ action: format });
    await wait(() => { const message = document.querySelector('.toast')?.textContent || ''; if (/失败|无法|无效|不能|超时|需要 Pandoc|failed|could not/i.test(message)) throw new Error(format + ': ' + message); return message.includes(format.toUpperCase() + ' exported'); });
    check(true, 'real Pandoc ' + format + ' export completes from the rendered complex document');
  }
  const convertedImports = {};
  for (const format of ['docx', 'odt', 'rtf', 'epub']) {
    const response = await window.desktop.importDocument(format); if (!response.ok) throw new Error(format + ': ' + response.error);
    const markdown = response.value.markdown;
    check(markdown.includes('复杂中文文档') && markdown.includes('中文甲') && markdown.includes('中文脚注内容') && markdown.includes('中文代码'), 'real ' + format + ' reimport retains Chinese headings, table text, footnotes and code');
    if (['docx', 'odt', 'epub'].includes(format)) check((markdown.includes('![') || markdown.includes('<img')) && markdown.includes('mc'), format + ' reimport retains extracted images and mathematical content');
    convertedImports[format] = markdown;
  }
  const importedRecord = { ...complexRecord, id: 'converted-import', name: '导入的复杂文档.md', content: convertedImports.docx };
  const importRegistration = await window.desktop.registerDraft(importedRecord); if (!importRegistration.ok) throw new Error(importRegistration.error);
  window.__omarkie.command({ action: 'opened', document: importedRecord });
  await wait(() => document.querySelector('.document-title')?.textContent.startsWith(importedRecord.name) && root()?.querySelectorAll('table tr').length === 3 && [...root().querySelectorAll('img')].some(image => image.naturalWidth > 0));
  check(true, 'reimported DOCX is editable and its persistent extracted media loads in native WebKit');
  window.__omarkie.command({ action: 'opened', document: saved.value });
  await wait(() => document.querySelector('.document-title')?.textContent === saved.value.name);
  const reopenDraft = {id:'reopen-draft',path:null,name:'Reopen-draft.md',content:'',savedContent:'',diskHash:null,lineEnding:'\n'};
  const registeredDraft = await window.desktop.registerDraft(reopenDraft); if (!registeredDraft.ok) throw new Error(registeredDraft.error);
  window.__omarkie.command({action:'opened',document:reopenDraft}); await wait(() => document.querySelector('.document-title')?.textContent === 'Reopen-draft.md');
  window.__omarkie.command({action:'close'}); await wait(() => document.querySelector('.document-title')?.textContent === 'WebKit-fixture.md');
  window.__omarkie.command({action:'reopen'}); await wait(() => document.querySelector('.document-title')?.textContent === 'Reopen-draft.md');
  check(true, "native reopen falls back to the same-window closed-document history when no closed window exists");
  window.__omarkie.command({action:'close'}); await wait(() => document.querySelector('.document-title')?.textContent === 'WebKit-fixture.md');
  await sourceMode(false);
  const paritySource = '# Native editing parity\n\n> - alpha\n> - beta\n\n| A | B |\n| --- | --- |\n| cellA | cellB |\n\n```sequence\nAlice->Bob: Native hello\nBob-->Alice: Native reply\n```\n\n```flow\nst=>start: Start\ne=>end: End\nst->e\n```\n';
  const parityRecord = {id:'native-parity',path:null,name:'Native-parity.md',content:paritySource,savedContent:paritySource,diskHash:null,lineEnding:'\n'};
  const parityRegistered = await window.desktop.registerDraft(parityRecord); if(!parityRegistered.ok) throw new Error(parityRegistered.error);
  window.__omarkie.command({action:'opened',document:parityRecord});
  await wait(() => document.querySelector('.document-title')?.textContent === parityRecord.name && root()?.querySelectorAll('.mermaid-block svg').length === 2);
  check(root().querySelector('[data-diagram-language="sequence"] svg').textContent.includes('Native hello'), 'native WebKit renders legacy sequence and flow through offline Mermaid');
  pointText('alpha',0); const first = getSelection().anchorNode;
  pointText('beta',4); const last = getSelection().anchorNode;
  getSelection().setBaseAndExtent(first,0,last,4); document.dispatchEvent(new Event('selectionchange'));
  root().dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',bubbles:true,cancelable:true}));
  await sourceMode(true); check(readSource() === paritySource.replace('> - alpha\n> - beta','>   - alpha\n>   - beta'), 'native multi-line quoted-list Tab preserves both list items');
  await sourceMode(false); window.__omarkie.command({action:'undo'});
  pointText('cellA',2);
  root().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',metaKey:true,bubbles:true,cancelable:true}));
  check(root().querySelectorAll('tbody tr').length === 2,'native Cmd-Enter inserts a table row');
  window.__omarkie.command({action:'undo'}); pointText('cellA',2); input('insertLineBreak');
  check(root().querySelectorAll('td br').length === 1,'native cell break renders as a real line break');
  input('insertText','新行'); await sourceMode(true); check(readSource() === paritySource.replace('cellA','ce<br>新行llA'),'native typing continues after the cell break');
  await sourceMode(false); window.__omarkie.command({action:'undo'});
  await sourceMode(true); check(readSource() === paritySource.replace('cellA','ce<br>llA'),'native Shift-Enter preserves the table with an inline cell break');
  await sourceMode(false); window.__omarkie.command({action:'undo'});
  await sourceMode(true); check(readSource() === paritySource,'native table undo and source round trip restore exact Markdown'); await sourceMode(false);
  pointText('cellA',2); window.__omarkie.command({action:'select-scope'});
  check(getSelection().toString() === 'cellA','native scope selection selects the entire table cell');
  window.__omarkie.command({action:'jump-selection'});
  check(getSelection().toString() === 'cellA','native jump to selection preserves its range');
  window.__omarkie.command({action:'select-line'});
  check(getSelection().toString().includes('cellA') && getSelection().toString().includes('cellB') && !getSelection().toString().includes('cellC'),'native line selection stays in one table row');
  pointText('cellA',2); window.__omarkie.command({action:'select-word'});
  window.__omarkie.command({action:'delete-word'});
  await sourceMode(true); check(readSource() === paritySource.replace('cellA',''),'native word deletion preserves table structure');
  await sourceMode(false); window.__omarkie.command({action:'undo'}); await sourceMode(true);
  check(readSource() === paritySource,'native rich undo restores word deletion before entering source');
  window.__omarkie.command({action:'select-word'}); window.__omarkie.command({action:'delete-word'});
  check(readSource() === paritySource.replace('cellA',''),'native source word deletion uses source selection');
  window.__omarkie.command({action:'undo'}); check(readSource() === paritySource,'native source word deletion undo restores exact Markdown');
  await sourceMode(false);

  const headerSource='# Native table header\n\n| Name | 中文 |';
  const headerRecord={id:'native-header-table',path:null,name:'Native-table-header.md',content:headerSource,savedContent:headerSource,diskHash:null,lineEnding:'\n'};
  const headerRegistered=await window.desktop.registerDraft(headerRecord);if(!headerRegistered.ok)throw Error(headerRegistered.error);
  window.__omarkie.command({action:'opened',document:headerRecord});await wait(()=>document.querySelector('.document-title')?.textContent===headerRecord.name);
  pointText('| Name | 中文 |','| Name | 中文 |'.length);input('insertParagraph');
  check(root().querySelectorAll('th').length===2 && root().querySelectorAll('td').length===2 && !!getSelection().anchorNode.parentElement.closest('td'),'native header Enter creates a table and focuses its first body cell');
  input('insertText','你好|中国');await sourceMode(true);
  const emptyHeaderTable=headerSource+'\n| --- | --- |\n|  |  |';
  check(readSource()===emptyHeaderTable.replace('|  |  |','| 你好\\|中国 |  |'),'native table pipe typing keeps Chinese content in one cell and survives source switching');
  await sourceMode(false);window.__omarkie.command({action:'undo'});await sourceMode(true);
  check(readSource()===emptyHeaderTable,'native table content undo is separate from table creation');
  await sourceMode(false);window.__omarkie.command({action:'undo'});await sourceMode(true);
  check(readSource()===headerSource,'native table creation undoes in one transaction');await sourceMode(false);
  window.__omarkie.command({action:'opened',document:saved.value});
  await wait(() => document.querySelector('.document-title')?.textContent === saved.value.name);
  pointText("粗测新体", 2);
  input("insertText", "保留");
  window.__omarkie.command({ action: "close-window" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    root().querySelector("strong").textContent.includes("保留"),
    "cancelled native close retains the dirty document and live editor",
  );
  check(errors.length === 0, "no WebKit runtime error or rejected promise");
  return { passed, errors, source, convertedImports };
} catch (error) {
  return {
    passed,
    errors,
    error: String(error),
    stack: error.stack,
    source: readSource(),
  };
}
