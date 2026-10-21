import DOMPurify from "dompurify";
type Engine = typeof import("./mathEngine");
let loader: Promise<Engine> | undefined;
let queue = Promise.resolve();
// One MathJax document per container, so TeX macros stay document-scoped across incremental runs.
const documents = new WeakMap<HTMLElement, ReturnType<Engine["createMathDocument"]>>();
// What each formula element last rendered; a changed data-tex or data-display renders again.
const rendered = new WeakMap<HTMLElement, string>();
const definesMacros = (tex: string) => /\\(?:new|renew|provide)command|\\[gxe]?def\b|\\let\b|\\DeclareMathOperator|\\newenvironment/.test(tex);
const signature = (target: HTMLElement) => `${target.dataset.tex}\u0001${target.dataset.display}`;
// Test seam: a stand-in for the MathJax engine.
export function setMathEngine(engine: Engine | null) {
  loader = engine ? Promise.resolve(engine) : undefined;
}
// Converts only formulas that are new or changed; formulas already rendered (including ones kept
// off-screen by the windowed editor) are left alone. A changed macro definition reaches every
// later formula in the container.
export async function renderMath(container: HTMLElement) {
  const targets = [...container.querySelectorAll<HTMLElement>(".mathjax-node")];
  const stale = (target: HTMLElement) => !target.dataset.ready || rendered.get(target) !== signature(target);
  // A definition rendering for the first time (e.g. scrolled into the window) or changing reaches
  // every later formula and every formula that failed, possibly for lack of that macro.
  const definer = targets.findIndex(target => stale(target) && definesMacros(target.dataset.tex || ""));
  const pending = targets.filter((target, index) => stale(target) || (definer >= 0 && (index > definer || target.classList.contains("math-error"))));
  if (!pending.length) return;
  loader ??= import("./mathEngine");
  const engine = await loader;
  const task = queue
    .catch(() => {})
    .then(async () => {
      let document = documents.get(container);
      if (!document) { document = engine.createMathDocument(); documents.set(container, document); }
      for (const target of pending) {
        if (!target.isConnected) continue;
        const tex = target.dataset.tex || "", current = signature(target);
        try {
          const result = await document.convertPromise(tex, { display: target.dataset.display === "true" });
          if (!target.isConnected || signature(target) !== current) continue;
          target.innerHTML = DOMPurify.sanitize(result.outerHTML, {
            USE_PROFILES: { svg: true, svgFilters: true, html: true },
          });
          target.classList.remove("math-error");
        } catch {
          if (signature(target) !== current) continue;
          target.textContent = tex;
          target.classList.add("math-error");
        }
        target.dataset.ready = "true";
        rendered.set(target, current);
      }
    });
  queue = task;
  await task;
}
