import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Loader2, Save, X } from "lucide-react";
import { host } from "../host";
import { t } from "../i18n";
import "./board.css";

type Scene = { type: "excalidraw"; version: 2; source: string; elements: readonly Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown> };
type Reply = { scene?: Scene; corrupt?: boolean; error?: string };

const appStateKeys = ["viewBackgroundColor", "gridSize", "gridModeEnabled", "theme", "zoom", "scrollX", "scrollY", "selectedElementIds"] as const;

function sanitize(elements: readonly Record<string, unknown>[], appState: Record<string, unknown>, files: Record<string, unknown>): Scene {
  const state: Record<string, unknown> = {};
  for (const key of appStateKeys) if (appState[key] !== undefined) state[key] = appState[key];
  const kept: Record<string, unknown> = {};
  for (const [id, file] of Object.entries(files ?? {})) {
    const value = file as { dataURL?: unknown; mimeType?: unknown; id?: unknown; created?: unknown };
    if (typeof value?.dataURL === "string" && value.dataURL.startsWith("data:")) kept[id] = { id: value.id, mimeType: value.mimeType, dataURL: value.dataURL, created: value.created };
  }
  return { type: "excalidraw", version: 2, source: "omarkie", elements, appState: state, files: kept };
}
const signature = (scene: Scene) => JSON.stringify([scene.elements.map(element => [element.id, element.version, element.versionNonce, element.isDeleted]), scene.appState, Object.keys(scene.files)]);

export default function BoardView({ note, magnet, name, close }: { note: string; magnet: string; name: string; close(): void }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const latest = useRef<Scene | null>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closed = useRef(false);
  const persisted = useRef("");

  useEffect(() => {
    document.documentElement.classList.add("board-open");
    return () => { document.documentElement.classList.remove("board-open"); };
  }, []);

  useEffect(() => {
    let live = true;
    void host.glass!({ action: "board", mode: "load", note, magnet }).then((reply: Reply) => {
      if (!live) return;
      if (reply.error) { setError(reply.error); setStatus("error"); return; }
      if (reply.corrupt) setWarning(t("This board file could not be read. A blank board is open and the damaged copy is kept beside it."));
      latest.current = reply.scene ?? null;
      if (reply.scene) persisted.current = signature(reply.scene);
      setScene(reply.scene ?? null);
      setStatus("ready");
    }).catch(error => { if (live) { setError((error as Error).message); setStatus("error"); } });
    return () => { live = false; };
  }, [note, magnet]);

  const save = useCallback(async () => {
    if (!latest.current) return;
    if (saving.current) await saving.current;
    if (!latest.current) return;
    const payload = latest.current;
    dirty.current = false;
    setStatus("saving");
    const job = host.glass!({ action: "board", mode: "save", note, magnet, scene: payload }).then(() => {
      if (closed.current) return;
      setStatus(dirty.current ? "ready" : "saved");
      setError("");
    }).catch(error => {
      dirty.current = true;
      if (!closed.current) { setStatus("error"); setError((error as Error).message); }
    }).finally(() => { saving.current = null; });
    saving.current = job;
    await job;
    if (dirty.current && !closed.current) await save();
  }, [note, magnet]);

  const schedule = useCallback(() => {
    dirty.current = true;
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = undefined; void save(); }, 700);
  }, [save]);

  const dismiss = useCallback(() => {
    closed.current = true;
    clearTimeout(timer.current);
    if (dirty.current) void save();
    close();
  }, [close, save]);

  const initial = useMemo(() => scene ? { elements: scene.elements as never[], appState: scene.appState, files: scene.files, scrollToContent: true } : null, [scene]);

  return <div className="board-backdrop" role="dialog" aria-modal="true" aria-label={name}>
    <section className="board-shell">
      <header className="board-heading">
        <div><strong>{name}</strong><span className="board-hint">{t("Local board · saved in .omarkie/assets")}</span></div>
        <div className="board-status" role="status" aria-live="polite">
          {status === "loading" && <Loader2 size={14} className="board-spin" />}
          {status === "saving" && <Loader2 size={14} className="board-spin" />}
          {status === "saved" && <Save size={14} />}
          <span>{status === "loading" ? t("Loading board…") : status === "saving" ? t("Saving…") : status === "error" ? t("Not saved") : t("Saved locally")}</span>
        </div>
        <button type="button" className="board-close" aria-label={t("Close board")} onClick={dismiss}><X size={18} /></button>
      </header>
      {warning && <p className="board-warning" role="alert">{warning}</p>}
      {error && <p className="board-warning" role="alert">{error}</p>}
      <div className="board-canvas">
        {!initial && status !== "error" && <div className="board-loading" role="status"><Loader2 size={22} className="board-spin" />{t("Loading board…")}</div>}
        {initial && <Excalidraw initialData={initial as never} theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
          onChange={(elements, appState, files) => {
            latest.current = sanitize(elements as unknown as Record<string, unknown>[], appState as unknown as Record<string, unknown>, files as unknown as Record<string, unknown>);
            // Excalidraw calls onChange on every render (hover, cursor); save only what would change the file.
            const next = signature(latest.current);
            if (next === persisted.current) return;
            persisted.current = next;
            schedule();
          }}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: true, toggleTheme: true } }} />}
      </div>
    </section>
  </div>;
}
