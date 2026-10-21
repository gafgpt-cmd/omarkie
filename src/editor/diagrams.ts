import DOMPurify from "dompurify";
import { diagramSource } from "./legacyDiagrams.ts";
import { t } from "../i18n.ts";
let loader: Promise<typeof import("mermaid")> | undefined;
let queue = Promise.resolve();
// Diagram colours come from the active theme; without the variables (export window) fall back to Mermaid's light/dark sets.
function diagramTheme() {
  const style = getComputedStyle(document.documentElement), value = (name: string) => style.getPropertyValue(name).trim();
  // Theme colours may be color-mix(); the computed value is rgb() or color(srgb …), converted to the hex Mermaid parses.
  const probe = document.createElement("span"); document.body.append(probe);
  const hex = (name: string) => {
    probe.style.color = `var(${name})`;
    const color = getComputedStyle(probe).color, srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color), rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
    const channels = srgb ? srgb.slice(1).map(v => Math.round(Number(v) * 255)) : rgb ? rgb.slice(1).map(Number) : null;
    return channels ? "#" + channels.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("") : "";
  };
  const [paper, ink, accent, code, border] = ["--paper", "--ink", "--accent", "--code", "--border"].map(hex);
  probe.remove();
  if (![paper, ink, accent, code, border].every(color => /^#[0-9a-f]{6}$/i.test(color))) return { theme: document.documentElement.dataset.appearance === "dark" ? "dark" as const : "neutral" as const };
  return { theme: "base" as const, themeVariables: { background: paper, mainBkg: code, primaryColor: code, secondaryColor: code, tertiaryColor: paper, primaryTextColor: ink, secondaryTextColor: ink, tertiaryTextColor: ink, textColor: ink, primaryBorderColor: accent, nodeBorder: accent, lineColor: accent, clusterBkg: paper, clusterBorder: border, edgeLabelBackground: paper, actorBkg: code, actorBorder: accent, actorTextColor: ink, signalColor: ink, signalTextColor: ink, noteBkgColor: paper, noteTextColor: ink, noteBorderColor: border, fontFamily: value("--document-font") || "sans-serif" } };
}
// Re-colours rendered diagrams after a theme change.
export async function refreshDiagrams() {
  for (const container of document.querySelectorAll<HTMLElement>(".rich-document")) {
    const rendered = container.querySelectorAll<HTMLElement>(".mermaid-block[data-ready]");
    if (!rendered.length) continue;
    for (const element of rendered) { delete element.dataset.ready; element.textContent = element.dataset.mermaid ?? ""; }
    await renderDiagrams(container);
  }
}
export async function renderDiagrams(container: HTMLElement) {
  const targets = [
    ...container.querySelectorAll<HTMLElement>(".mermaid-block"),
  ].filter((element) => !element.dataset.ready);
  if (!targets.length) return;
  loader ??= import("mermaid");
  const { default: mermaid } = await loader;
  const render = async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      ...diagramTheme(),
      flowchart: { htmlLabels: false },
    });
    for (const element of targets) {
      if (!element.isConnected) continue;
      element.dataset.mermaid ??= element.textContent || "";
      try {
        const { svg } = await mermaid.render(
          `diagram-${crypto.randomUUID()}`,
          diagramSource(element.dataset.diagramLanguage || "mermaid", element.dataset.mermaid),
        );
        if (element.isConnected) {
          element.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          element.dataset.ready = "true";
        }
      } catch (error) {
        element.textContent = element.dataset.mermaid!;
        element.classList.add("diagram-error");
        element.title = error instanceof Error ? error.message : t("图表语法错误");
      }
    }
  };
  const task = queue.catch(() => {}).then(render);
  queue = task;
  await task;
}
