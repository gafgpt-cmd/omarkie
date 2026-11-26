import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Mic, RefreshCw, Search, Sparkles, Square, Wand2, X } from "lucide-react";
import { t } from "../i18n";
import type { LiveTutor } from "./tutor-live";
import CompareSlider from "./CompareSlider";

type Preview = { base64: string; mime: string } | null;
export type SwapCandidate = {
  id: string; kind: string; title?: string | null; source?: string | null; sourceLabel?: string | null;
  licence?: { code?: string; version?: string | null; url?: string | null; attribution?: string | null; required?: boolean } | null;
  width?: number; height?: number; bytes?: number; text?: string | null; operations?: string[];
  sourceUrl?: string | null; vaultPath?: string | null; downloadUrl?: string | null; absolute?: string | null;
  base64?: string | null; bytesBase64?: string | null; preview?: Preview; previewOf?: string; current?: boolean;
};
type DiffRow = { kind: "context" | "add" | "remove"; text: string };
type ReviewedSwap = { swapId: string; hash: string; rows: DiffRow[]; footnote: string; candidate: SwapCandidate; element: string };
type Options = {
  element: { id: string; kind: string; line: number; headings: string[]; quote: string; markdown: string; heading_path: string };
  kind: string; actions: string[]; hooks: { enhance: boolean; generate: boolean; stt: boolean };
  online: { allowed: boolean; code: string | null; reason: string; searched: boolean };
  neverOnline: boolean; candidates: SwapCandidate[]; warnings: { code: string; message: string }[]; complaint: string;
};
type SwapRecord = { swapId: string; mode: string; kind: string; element?: { id: string } | null; title?: string | null; at?: string | number; attachment?: string | null };
type Proposal = { swapId: string; candidate: SwapCandidate; element?: { id: string } | null; at: string | number };
type State = { swaps: SwapRecord[]; proposals: Proposal[]; neverOnline: boolean; hooks: { enhance: boolean; generate: boolean; stt: boolean } };

const actionLabels: Record<string, string> = {
  enhance: "Enhance", find: "Find better", generate: "Generate", rewrite: "Rewrite", redraw: "Redraw",
};
async function glassCall(request: Record<string, unknown>) {
  const call = window.desktop?.glass;
  if (!call) throw new Error(t("Glass storage is not available here."));
  const reply = await call(request);
  if (!reply?.ok) throw new Error(reply?.error ?? t("Glass storage refused the change."));
  return reply.value ?? {};
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const dataUrl = (preview: Preview | undefined) => preview ? `data:${preview.mime};base64,${preview.base64}` : null;

function MermaidPreview({ source }: { source: string }) {
  const [markup, setMarkup] = useState(""), [problem, setProblem] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // Mermaid is a heavy renderer: load it only when a diagram is compared, as the editor does.
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "neutral" });
        const { svg } = await mermaid.render(`swap-flow-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`, source);
        if (alive) { setMarkup(svg); setProblem(""); }
      } catch (error) { if (alive) { setMarkup(""); setProblem(message(error)); } }
    })();
    return () => { alive = false; };
  }, [source]);
  if (problem) return <p className="glass-swap-problem" data-swap-mermaid-error>{problem}</p>;
  return <div className="glass-swap-mermaid" data-swap-mermaid dangerouslySetInnerHTML={{ __html: markup }} />;
}

interface Props {
  note: string;
  element: { id: string; kind: string; line: number };
  live?: LiveTutor;
  onClose(): void;
  onApplied(): void | Promise<void>;
}

// G22: one panel drives pick → complaint → candidates → compare → cover or replace → undo.
// It never writes the page on its own; every apply is an explicit button.
export default function GlassSwapPanel({ note, element, live, onClose, onApplied }: Props) {
  const [options, setOptions] = useState<Options>();
  const [state, setState] = useState<State>();
  const [kind, setKind] = useState<string>();
  const [complaint, setComplaint] = useState("");
  const [online, setOnline] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [compare, setCompare] = useState(50);
  const [preview, setPreview] = useState<ReviewedSwap>();
  const [staleSwap, setStaleSwap] = useState<string>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const chunks = useRef<Blob[]>([]);

  const loadState = useCallback(async () => {
    const value = await glassCall({ note, action: "swap-state" }) as State;
    setState(value);
    return value;
  }, [note]);

  // A switch the reader just flipped must be on disk before a search reads it, or the search runs
  // against the old setting: the toggle's write is the barrier every dependent call awaits.
  const settingsWrite = useRef<Promise<unknown>>(Promise.resolve());
  const loadOptions = useCallback(async (nextKind?: string, nextComplaint = complaint, nextOnline = online) => {
    setBusy(true); setPreview(undefined); setNotice("");
    await settingsWrite.current.catch(() => undefined);
    try {
      const value = await glassCall({ note, action: "swap-options", element: element.id,
        ...(nextKind ? { kind: nextKind } : {}), ...(nextComplaint.trim() ? { complaint: nextComplaint } : {}),
        ...(nextOnline ? { online: true } : {}) }) as Options;
      setOptions(value); setKind(value.kind); setComplaint(value.complaint ?? nextComplaint);
      const first = value.candidates.find(candidate => !candidate.current);
      setSelected(first?.id);
      if (!nextComplaint.trim() && value.element.quote) setComplaint("");
      // Proposals an agent left while the panel was opening are part of the same picture.
      void loadState().catch(() => undefined);
    } catch (error) { setNotice(message(error)); }
    finally { setBusy(false); }
  }, [complaint, element.id, note, online]);

  useEffect(() => {
    void loadOptions();
    void loadState().catch(error => setNotice(message(error)));
    // A proposal written just before the panel opened may still be landing in the journal; one
    // follow-up read catches it without polling.
    const settle = window.setTimeout(() => { void loadState().catch(() => undefined); }, 300);
    return () => window.clearTimeout(settle);
  }, [element.id, note]);

  // An agent's proposal, dismiss or undo arrives as a journal write; the open panel follows it.
  useEffect(() => {
    const stop = window.desktop?.onGlassChanged?.((event: { note?: string; action?: string }) => {
      if (/^swap-/u.test(String(event?.action ?? ""))) void loadState().catch(() => undefined);
    });
    return () => stop?.();
  }, [loadState]);

  const candidate = options?.candidates.find(row => row.id === selected);
  const current = options?.candidates.find(row => row.current);
  const latestSwap = state?.swaps?.[0];

  async function tutorCandidate() {
    if (!live) { setNotice(t("The Tutor is offline. Write your own words or use Find better.")); return; }
    if (!options) return;
    setBusy(true); setNotice("");
    try {
      const redraw = kind === "redraw";
      const question = redraw
        ? t("Rewrite this Mermaid diagram so it reads clearly. Keep the same meaning. Answer with JSON: {\"feedback\":\"...\",\"replacement\":\"<mermaid source>\"}")
        : t("Rewrite this paragraph simpler and as a study cue, in the note's language. Keep every fact. Answer with JSON: {\"feedback\":\"...\",\"replacement\":\"<rewritten text>\"}");
      const reply = await live.send({ verb: "check", anchor: { block: options.element.markdown, headings: options.element.headings,
        line: options.element.line, quote: options.element.quote }, text: options.element.quote }, question, "bubble", true);
      const text = reply?.replacement?.trim();
      if (!text) { setNotice(live.problem ? `${t("The Tutor returned no rewrite.")} ${live.problem}` : t("The Tutor returned no rewrite.")); return; }
      const found: SwapCandidate = { id: `tutor-${Date.now().toString(36)}`, kind: redraw ? "redraw" : "rewrite",
        title: redraw ? "Redrawn diagram" : "Tutor rewrite", source: "tutor", sourceLabel: "the Tutor",
        licence: { code: "tutor", version: null, url: null, attribution: "Tutor", required: false }, text };
      setOptions(value => value ? { ...value, candidates: [...value.candidates.slice(0, 1), found] } : value);
      setSelected(found.id);
    } catch (error) { setNotice(message(error)); }
    finally { setBusy(false); }
  }

  async function record() {
    if (recording) { recorder.current?.stop(); return; }
    setNotice("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "" });
      chunks.current = [];
      media.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
      media.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        setRecording(false);
        void (async () => {
          const blob = new Blob(chunks.current, { type: media.mimeType || "audio/webm" });
          const audio = await blob.arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(audio);
          for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          try {
            const reply = await glassCall({ note, action: "swap-voice", audio: btoa(binary),
              extension: blob.type.includes("webm") ? "webm" : blob.type.includes("ogg") ? "ogg" : "wav" });
            if (!reply?.ok && reply?.hint) { setNotice(reply.hint); return; }
            if (reply?.text) { setComplaint(reply.text); await loadOptions(kind, reply.text, online); }
            else setNotice(t("No words came back from the recording."));
          } catch (error) { setNotice(message(error)); }
        })();
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch (error) { setNotice(message(error)); }
  }

  // A proposal names its own element; applying it must not write into the element this panel happens to show.
  async function apply(mode: "cover" | "replace", chosen = candidate, target = element.id, proposal?: string) {
    if (!chosen) { setNotice(t("Choose a candidate first.")); return; }
    setBusy(true); setNotice("");
    try {
      if (mode === "replace") {
        // Every Replace press reviews the candidate it was pressed for, never an older preview.
        const value = await glassCall({ note, action: "swap-apply", element: target, candidate: chosen, mode: "replace", approved: false,
          ...(proposal ? { swapId: proposal } : {}) });
        setPreview({ swapId: value.swapId, hash: value.expectedHash, rows: value.diff ?? [], footnote: value.footnote ?? "", candidate: chosen, element: target });
        return;
      }
      // A proposal's id retires its card; the note write stays the same cover path.
      const value = await glassCall({ note, action: "swap-apply", element: target, candidate: chosen, mode: "cover", approved: true,
        ...(proposal ? { swapId: proposal } : {}) });
      setNotice(t("Covered on your glass. The note is untouched."));
      await loadState().catch(() => undefined);
      await onApplied();
    } catch (error) { setNotice(message(error)); }
    finally { setBusy(false); }
  }

  async function accept(reviewed: ReviewedSwap) {
    setBusy(true); setNotice("");
    try {
      // The preview owns the candidate, the hash and the swap id: the write is what was reviewed.
      const value = await glassCall({ note, action: "swap-apply", element: reviewed.element, candidate: reviewed.candidate, mode: "replace", approved: true,
        expectedHash: reviewed.hash, swapId: reviewed.swapId });
      if (value?.stale) { setNotice(value.message ?? t("The note changed; preview again.")); setPreview(undefined); return; }
      setPreview(undefined);
      setNotice(t("Replaced in the page."));
      await loadState().catch(() => undefined);
      await onApplied();
    } catch (error) { setNotice(message(error)); }
    finally { setBusy(false); }
  }

  async function restore(swap: string) {
    setBusy(true); setNotice("");
    try {
      const value = await glassCall({ note, action: "swap-restore", swap, ...(staleSwap === swap ? { force: true } : {}) });
      if (value?.undoStale) { setStaleSwap(swap); setNotice(value.message ?? t("Undo again to restore it anyway.")); return; }
      setStaleSwap(undefined);
      setNotice(t("Restored the original."));
      await loadState().catch(() => undefined);
      await onApplied();
    } catch (error) { setNotice(message(error)); }
    finally { setBusy(false); }
  }

  async function neverOnline(on: boolean) {
    // Flip the switch at once; the journal write follows and reports its own failure.
    setOptions(value => value ? { ...value, neverOnline: on } : value);
    setState(value => value ? { ...value, neverOnline: on } : value);
    if (on) setOnline(false);
    const write = glassCall({ note, action: "swap-settings", neverOnline: on })
      .catch((error: Error) => { setNotice(message(error)); });
    settingsWrite.current = write;
    await write;
  }

  async function dismiss(swap: string) {
    try { await glassCall({ note, action: "swap-dismiss", swap }); await loadState(); }
    catch (error) { setNotice(message(error)); }
  }

  return <aside className="glass-swap-panel" data-swap-panel data-swap-element={element.id} aria-label={t("Change element")}>
    <header className="glass-swap-head">
      <strong>{t("Change {{kind}}", { kind: options?.element.kind ?? element.kind })}</strong>
      <button type="button" data-swap-close aria-label={t("Close")} title={t("Close")} onClick={onClose}><X size={14} /></button>
    </header>
    <label className="glass-swap-complaint">{t("What is wrong?")}
      <textarea data-swap-complaint rows={2} value={complaint} disabled={busy}
        placeholder={t("Say or type the problem; then find a better one.")}
        onChange={event => setComplaint(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void loadOptions(kind, complaint, online); } }} />
    </label>
    <div className="glass-swap-voice">
      <button type="button" data-swap-mic data-recording={recording ? "on" : undefined} disabled={busy || !options?.hooks.stt}
        title={options?.hooks.stt ? t("Say it") : t("Speech to text is not configured.")} onClick={() => void record()}>
        {recording ? <Square size={13} /> : <Mic size={13} />} {recording ? t("Stop") : t("Say it")}
      </button>
      <button type="button" data-swap-search disabled={busy} onClick={() => void loadOptions(kind, complaint, online)}><Search size={13} /> {t("Find")}</button>
    </div>
    <div className="glass-swap-chips" role="group" aria-label={t("Change options")}>
      {(options?.actions ?? []).filter(action => action !== "enhance" || options?.hooks.enhance)
        .filter(action => action !== "generate" || options?.hooks.generate)
        .map(action => <button key={action} type="button" data-swap-kind={action} aria-pressed={kind === action}
          disabled={busy} title={actionLabels[action]}
          onClick={() => void loadOptions(action, complaint, online)}>{actionLabels[action]}</button>)}
      {(kind === "rewrite" || kind === "redraw") && <button type="button" data-swap-tutor disabled={busy || !live}
        onClick={() => void tutorCandidate()}><Wand2 size={13} /> {t("Ask the Tutor")}</button>}
    </div>
    {kind === "find" && <label className="glass-swap-online">
      <input type="checkbox" data-swap-online checked={online} disabled={options?.neverOnline || busy}
        onChange={event => { setOnline(event.target.checked); void loadOptions(kind, complaint, event.target.checked); }} />
      {options?.neverOnline ? t("This vault never goes online.") : t("Search Commons and Openverse (online)")}
    </label>}
    {busy && <p className="glass-swap-progress" role="status"><RefreshCw size={12} /> {t("Looking…")}</p>}
    {notice && <p className="glass-swap-notice" role="status" data-swap-notice>{notice}</p>}
    {options?.warnings?.length ? <ul className="glass-swap-warnings" data-swap-warnings>
      {options.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}
    </ul> : null}

    {options && options.candidates.length > 0 && <>
      <div className="glass-swap-cards" data-swap-cards>
        {options.candidates.map(row => <button key={row.id} type="button" data-swap-candidate={row.id} aria-pressed={selected === row.id}
          className="glass-swap-card" onClick={() => { setSelected(row.id); setPreview(undefined); }}>
          <span className="glass-swap-face">
            {row.kind === "rewrite" ? <pre>{String(row.text ?? "").slice(0, 160)}</pre>
              : row.kind === "redraw" ? <pre className="glass-swap-code">{String(row.text ?? "").slice(0, 160)}</pre>
                : row.preview ? <img src={dataUrl(row.preview) ?? ""} alt={row.title ?? ""} /> : <span>{t("No preview")}</span>}
          </span>
          <span className="glass-swap-title">{row.current ? t("Current") : row.title ?? t("Candidate")}</span>
          <span className="glass-swap-meta">{row.current ? t("in this page")
            : [row.sourceLabel ?? row.source ?? "", row.licence?.code
              ? `${String(row.licence.code).toUpperCase()}${row.licence.version ? ` ${row.licence.version}` : ""}` : "",
              row.width && row.height ? `${row.width}×${row.height}` : ""].filter(Boolean).join(" · ")}</span>
        </button>)}
      </div>
      {candidate && current && !candidate.current && candidate.kind !== "rewrite" && candidate.kind !== "redraw" &&
        <div className="glass-swap-compare" data-swap-compare>
          <CompareSlider left={dataUrl(current.preview)} right={dataUrl(candidate.preview)} leftAlt={t("Current")} rightAlt={candidate.title ?? t("Candidate")}
            value={compare} direction="horizontal" before={t("Current")} after={t("Candidate")}
            onChange={setCompare} onCommit={setCompare} />
        </div>}
      {candidate && !candidate.current && (candidate.kind === "rewrite" || candidate.kind === "redraw") && <>
        <div className="glass-swap-textdiff" data-swap-textdiff>
          <div><h4>{t("Current")}</h4><pre>{options.element.quote}</pre></div>
          <div><h4>{candidate.title ?? t("Candidate")}</h4><pre>{candidate.text}</pre></div>
        </div>
        {candidate.kind === "redraw" && candidate.text && <MermaidPreview source={candidate.text} />}
      </>}
    </>}

    {preview && <div className="glass-swap-preview" data-swap-preview>
      <h4>{t("Replace in page — review")}</h4>
      <div className="glass-swap-diff">{preview.rows.map((row, index) =>
        <span key={index} data-kind={row.kind}>{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "} {row.text || "\u00a0"}</span>)}</div>
      <p className="glass-swap-footnote">{preview.footnote}</p>
      <div className="glass-swap-actions">
        <button type="button" data-swap-accept disabled={busy} onClick={() => void accept(preview)}><Check size={13} /> {t("Accept replace")}</button>
        <button type="button" data-swap-cancel-preview onClick={() => setPreview(undefined)}>{t("Cancel")}</button>
      </div>
    </div>}

    {candidate && !candidate.current && !preview && <div className="glass-swap-actions">
      <button type="button" data-swap-cover disabled={busy} onClick={() => void apply("cover")}><Sparkles size={13} /> {t("Cover on my glass")}</button>
      <button type="button" data-swap-replace disabled={busy} onClick={() => void apply("replace")} title={t("edits this note")}>
        {t("Replace in page")}</button>
    </div>}
    {candidate && !candidate.current && <p className="glass-swap-hint">{t("Cover leaves the note untouched; Replace edits this note.")}</p>}

    {latestSwap && <div className="glass-swap-undo" data-swap-undo>
      <span>{t("Last change: {{title}} ({{mode}})", { title: latestSwap.title ?? latestSwap.kind, mode: latestSwap.mode })}</span>
      <button type="button" data-swap-restore disabled={busy} onClick={() => void restore(latestSwap.swapId)}>Undo</button>
    </div>}

    {state?.proposals?.length ? <section className="glass-swap-proposals" data-swap-proposals>
      <h4>{t("Proposed changes")}</h4>
      {state.proposals.map(proposal => <article key={proposal.swapId} data-swap-proposal={proposal.swapId}>
        <span>{proposal.candidate.title ?? proposal.candidate.kind}</span>
        <span className="glass-swap-meta">{proposal.candidate.sourceLabel ?? proposal.candidate.source ?? ""}</span>
        <div className="glass-swap-actions">
          <button type="button" disabled={busy} onClick={() => void apply("cover", proposal.candidate, proposal.element?.id ?? element.id, proposal.swapId)}>{t("Cover")}</button>
          <button type="button" disabled={busy} onClick={() => void apply("replace", proposal.candidate, proposal.element?.id ?? element.id, proposal.swapId)}>{t("Replace")}</button>
          <button type="button" disabled={busy} onClick={() => void dismiss(proposal.swapId)}>{t("Dismiss")}</button>
        </div>
      </article>)}
    </section> : null}

    <footer className="glass-swap-foot">
      <label><input type="checkbox" data-swap-never-online checked={options?.neverOnline ?? state?.neverOnline ?? false}
        onChange={event => void neverOnline(event.target.checked)} /> {t("Never search online in this vault")}</label>
    </footer>
  </aside>;
}
