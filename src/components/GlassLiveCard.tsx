import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, EyeOff, RotateCcw } from "lucide-react";
import DOMPurify from "dompurify";
import { calcRangeText, evaluateCalc, type CalcResult } from "../../shared/calc-model.mjs";
import { flowAt, flowMermaid, flowNodeId, flowOutline, flowPathFromId, type FlowNode } from "../../shared/flow-model.mjs";
import type { GlassCard } from "../glass/card-model";
import { t } from "../i18n";

export interface CalcValues { [key: string]: string }

// A calculator card: the result is recomputed from the session's inputs and never stored.
export function CalcCardBody({ card, values, onChange }: {
  card: GlassCard; values: CalcValues; onChange(values: CalcValues): void;
}) {
  const [result, setResult] = useState<CalcResult>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const filled = card.inputs.every(input => String(values[input.key] ?? "").trim() !== "");
      if (!filled) { setResult(undefined); return; }
      const next = await evaluateCalc(card, values);
      if (alive.current) setResult(next);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [card, values]);
  const display = result?.ok
    ? <><strong data-card-value>{result.display}</strong> <span data-card-result-unit>{card.unit}</span> <small data-card-precision>{result.precision} dp</small></>
    : result?.error
      ? <span className="glass-card-error" role="alert" data-card-error>{result.error}</span>
      : <span className="glass-card-empty" data-card-empty>{t("Fill every input")}</span>;
  const precisionFlag = result?.flags?.find(flag => flag.key === "result");
  return <div className="glass-card-calc" data-card-calc>
    <p className="glass-card-formula" data-card-formula><span>{t("Formula")}</span> <code>{card.formula}</code> → <strong data-card-formula-unit>{card.unit}</strong></p>
    <div className="glass-card-inputs" role="group" aria-label={t("Inputs")}>
      {card.inputs.map(input => {
        const flag = result?.flags?.find(item => item.key === input.key), range = calcRangeText(input);
        return <label key={input.key} className="glass-card-input" data-card-input={input.key}>
          <span className="glass-card-input-head">{input.label || input.key}<small>{input.unit}</small></span>
          <input type="number" step="any" inputMode="decimal" value={values[input.key] ?? ""}
            aria-invalid={flag ? true : undefined} aria-describedby={flag ? `card-flag-${card.id}-${input.key}` : undefined}
            onChange={event => onChange({ ...values, [input.key]: event.target.value })} />
          {range && <small className="glass-card-range" data-card-range>{t("Norm")}: {range}</small>}
          {flag && <small className="glass-card-flag" role="alert" id={`card-flag-${card.id}-${input.key}`} data-card-flag={input.key}>{flag.message}</small>}
        </label>;
      })}
    </div>
    <p className="glass-card-result" aria-live="polite" data-card-result data-card-result-state={result?.ok ? "ok" : result?.error ? "error" : "empty"}>
      {display}
    </p>
    {precisionFlag && <p className="glass-card-flag" role="alert" data-card-flag="result">{precisionFlag.message}</p>}
    <p className="glass-card-citation" data-card-citation><span>{t("Citation")}</span> {card.citation}</p>
  </div>;
}

// A flow card walks the tree one decision at a time, starts at the first question and can show the whole tree.
export function FlowCardBody({ card }: { card: GlassCard }) {
  const [path, setPath] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const flow = card.flow as FlowNode;
  const node = flowAt(flow, path);
  const trail = trailOf(flow, path);
  const pick = useCallback((next: number[]) => setPath(next), []);
  const reset = () => setPath([]);
  return <div className="glass-card-flow" data-card-flow data-flow-path={path.join(".")}>
    {trail.length > 0 && <ol className="glass-card-trail" aria-label={t("Steps taken")}>
      {trail.map((label, index) => <li key={`${label}:${index}`} data-card-trail={index}>{label}</li>)}
    </ol>}
    {node && "result" in node
      ? <div className="glass-card-flow-result" data-flow-result>
        <p><span>{t("Result")}</span> {node.result}</p>
      </div>
      : node ? <div className="glass-card-flow-step" data-flow-step>
        <p className="glass-card-flow-question" data-flow-question>{node.question}</p>
        <div className="glass-card-flow-choices" role="group" aria-label={t("Choices")}>
          {node.choices.map((choice, index) => <button type="button" key={`${choice.label}:${index}`} data-flow-choice={index}
            onClick={() => setPath([...path, index])}>{choice.label}</button>)}
        </div>
      </div> : <p className="glass-card-error" role="alert">{t("This step is out of reach.")}</p>}
    <div className="glass-card-flow-foot">
      <button type="button" data-flow-back disabled={!path.length} onClick={() => setPath(path.slice(0, -1))}>
        <ArrowLeft size={11} aria-hidden="true" /><span>{t("Back")}</span>
      </button>
      <button type="button" data-flow-reset disabled={!path.length} onClick={reset}>
        <RotateCcw size={11} aria-hidden="true" /><span>{t("Start over")}</span>
      </button>
      <button type="button" data-flow-all aria-pressed={showAll} onClick={() => setShowAll(value => !value)}>
        {showAll ? t("Hide steps") : t("Show all steps")}
      </button>
      <button type="button" data-flow-diagram-toggle aria-pressed={showDiagram} onClick={() => setShowDiagram(value => !value)}>
        {showDiagram ? <EyeOff size={11} aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />}<span>{t("Diagram")}</span>
      </button>
    </div>
    {showAll && <pre className="glass-card-flow-outline" data-flow-outline>{flowOutline(flow).join("\n")}</pre>}
    {showDiagram && <FlowDiagram flow={flow} title={card.title} onPick={pick} />}
    <p className="glass-card-citation" data-card-citation><span>{t("Citation")}</span> {card.citation}</p>
  </div>;
}

function trailOf(flow: FlowNode, path: number[]): string[] {
  const labels: string[] = [];
  let node: FlowNode | undefined = flow;
  for (const step of path) {
    if (!node || !("choices" in node) || !node.choices[step]) break;
    labels.push(node.choices[step].label);
    node = node.choices[step].next;
  }
  return labels;
}

// Mermaid stays at securityLevel 'strict'; clicks are ours, keyed by the node ids we generated.
function FlowDiagram({ flow, title, onPick }: { flow: FlowNode; title: string; onPick(path: number[]): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(() => document.documentElement.dataset.appearance === "dark");
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.appearance === "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    const hostElement = host.current;
    if (!hostElement) return;
    (async () => {
      try {
        // Static import would put Mermaid's 5.5 MB bundle in every session; a diagram loads only when asked.
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: dark ? "dark" : "neutral", flowchart: { htmlLabels: false } });
        const { svg } = await mermaid.render(`glass-flow-${crypto.getRandomValues(new Uint32Array(3)).join("-")}`, flowMermaid(flow, { title }));
        if (!alive) return;
        hostElement.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        for (const group of hostElement.querySelectorAll<SVGGElement>("g.node")) {
          const found = pathOfGroup(group.id);
          if (!found) continue;
          group.setAttribute("data-flow-node", flowNodeId(found));
          group.setAttribute("role", "button");
          group.setAttribute("tabindex", "0");
          group.style.cursor = "pointer";
          group.addEventListener("click", () => onPick(found));
          group.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onPick(found);
          });
        }
      } catch (failure) {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => { alive = false; };
  }, [dark, flow, title, onPick]);
  return <div className="glass-flow-diagram" data-flow-diagram>
    <div ref={host} />
    {error && <p className="glass-card-error" role="alert" data-flow-diagram-error>{error}</p>}
  </div>;
}

// Mermaid prefixes and suffixes its own ids; our node id survives as one hyphen-separated part.
function pathOfGroup(id: string): number[] | undefined {
  for (const part of String(id ?? "").split("-").reverse()) {
    const path = flowPathFromId(part);
    if (path !== null) return path;
  }
  return undefined;
}
