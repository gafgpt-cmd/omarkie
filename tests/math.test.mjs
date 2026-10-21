import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser", "NodeFilter"]) globalThis[key] = dom.window[key];
const { renderMath, setMathEngine } = await import("../src/editor/math.ts");

// A stand-in engine that records every conversion and how many documents were created.
function fakeEngine() {
  const calls = [], documents = [];
  setMathEngine({
    createMathDocument() {
      const id = documents.length;
      documents.push(id);
      return {
        async convertPromise(tex, { display }) {
          calls.push(tex);
          if (tex.includes("\\broken")) throw new Error("bad tex");
          const element = document.createElement("div");
          element.innerHTML = `<svg data-document="${id}" data-display="${display}"><text>${tex}</text></svg>`;
          return element.firstElementChild;
        },
      };
    },
  });
  return { calls, documents };
}
function container(formulas) {
  const element = document.createElement("div");
  element.innerHTML = formulas.map(([tex, display = false]) => `<p><span class="mathjax-node" data-tex="${tex}" data-display="${display}">${tex}</span></p>`).join("");
  document.body.append(element);
  return element;
}
const nodes = element => [...element.querySelectorAll(".mathjax-node")];

test("formulas are converted once and left alone on later passes", async () => {
  const engine = fakeEngine(), root = container([["a+b"], ["c^2", true], ["\\frac12"]]);
  await renderMath(root);
  assert.deepEqual(engine.calls, ["a+b", "c^2", "\\frac12"]);
  assert.ok(nodes(root).every(node => node.dataset.ready === "true" && node.querySelector("svg")));
  assert.equal(nodes(root)[1].querySelector("svg").dataset.display, "true");
  await renderMath(root);
  await renderMath(root);
  assert.equal(engine.calls.length, 3, "no re-conversion when nothing changed");
  root.remove();
});

test("only new or changed formulas convert; a window shift re-inserting rendered elements costs nothing", async () => {
  const engine = fakeEngine(), root = container([["x"], ["y"], ["z"]]);
  await renderMath(root);
  engine.calls.length = 0;
  // A new formula appears (new element, no data-ready).
  const extra = document.createElement("p");
  extra.innerHTML = `<span class="mathjax-node" data-tex="w" data-display="false">w</span>`;
  root.append(extra);
  await renderMath(root);
  assert.deepEqual(engine.calls, ["w"]);
  // An edit changes one formula's source.
  const second = nodes(root)[1];
  second.dataset.tex = "y+1";
  await renderMath(root);
  assert.deepEqual(engine.calls, ["w", "y+1"]);
  assert.equal(second.querySelector("text").textContent, "y+1");
  // Elements removed and re-attached (the windowed editor's LRU) keep their render.
  const detached = nodes(root).map(node => node.parentElement);
  for (const p of detached) p.remove();
  await renderMath(root);
  for (const p of detached) root.append(p);
  await renderMath(root);
  assert.deepEqual(engine.calls, ["w", "y+1"]);
  assert.equal(engine.documents.length, 1, "one MathJax document per container keeps macros");
  root.remove();
});

test("a changed macro definition re-renders the formulas after it, not the ones before", async () => {
  const engine = fakeEngine(), root = container([["a"], ["\\newcommand{\\R}{\\mathbb R}"], ["\\R"], ["b"]]);
  await renderMath(root);
  engine.calls.length = 0;
  nodes(root)[1].dataset.tex = "\\newcommand{\\R}{\\mathbf R}";
  await renderMath(root);
  assert.deepEqual(engine.calls, ["\\newcommand{\\R}{\\mathbf R}", "\\R", "b"]);
  root.remove();
});

test("a failing formula shows its source once and is retried only after it changes", async () => {
  const engine = fakeEngine(), root = container([["\\broken"], ["ok"]]);
  await renderMath(root);
  const bad = nodes(root)[0];
  assert.equal(bad.classList.contains("math-error"), true);
  assert.equal(bad.textContent, "\\broken");
  await renderMath(root);
  assert.deepEqual(engine.calls, ["\\broken", "ok"]);
  bad.dataset.tex = "fixed";
  await renderMath(root);
  assert.deepEqual(engine.calls, ["\\broken", "ok", "fixed"]);
  root.remove();
});

test("a formula edited while its conversion is in flight is not overwritten by the stale result", async () => {
  const started = [], finish = [];
  setMathEngine({
    createMathDocument() {
      return {
        convertPromise: tex => new Promise(resolve => { started.push(tex); finish.push(() => { const element = document.createElement("div"); element.innerHTML = `<svg><text>${tex}</text></svg>`; resolve(element.firstElementChild); }); }),
      };
    },
  });
  const root = container([["slow"]]), node = nodes(root)[0];
  const first = renderMath(root);
  while (!started.length) await new Promise(resolve => setTimeout(resolve, 1));
  node.dataset.tex = "faster";
  finish[0]();
  await first;
  assert.equal(node.dataset.ready, undefined, "stale result discarded");
  assert.equal(node.querySelector("svg"), null);
  const second = renderMath(root);
  while (started.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  finish[1]();
  await second;
  assert.deepEqual(started, ["slow", "faster"]);
  assert.equal(node.querySelector("text").textContent, "faster");
  assert.equal(node.dataset.ready, "true");
  root.remove();
});

test("formulas that failed for a missing macro render once its definition enters the window", async () => {
  setMathEngine({ createMathDocument() { const macros = new Set(); return { async convertPromise(tex) {
    for (const match of tex.matchAll(/\\newcommand\{\\(\w+)\}/g)) macros.add(match[1]);
    for (const match of tex.matchAll(/\\(\w+)/g)) if (match[1] !== "newcommand" && !macros.has(match[1])) throw new Error("undefined");
    const element = document.createElement("span"); element.textContent = "ok"; return element; } }; } });
  const root = document.createElement("div"); document.body.append(root);
  const node = tex => { const span = document.createElement("span"); span.className = "mathjax-node"; span.dataset.tex = tex; span.dataset.display = "false"; return span; };
  const user = node("\\R^2"); root.append(user);
  await renderMath(root);
  assert.ok(user.classList.contains("math-error"));
  root.prepend(node("\\newcommand{\\R}{x}"));
  await renderMath(root);
  assert.equal(user.textContent, "ok");
  assert.ok(!user.classList.contains("math-error"));
  root.remove(); setMathEngine(null);
});
