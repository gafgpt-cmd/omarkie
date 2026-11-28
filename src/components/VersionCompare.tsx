import { useEffect, useMemo, useRef, useState } from "react";
import { diffArrays } from "diff";
import { Dialog } from "./Dialog";
import { host } from "../host";
import { language, t } from "../i18n";
import type { ConflictCopy } from "../../shared/sync-conflicts.mjs";
import type { ConflictRequest, DocumentRecord, FileEntry } from "../types";
import "./version-compare.css";

export type CopyEntry = FileEntry & { copy: ConflictCopy };
interface Props {
  record: DocumentRecord;
  mode: "disk" | "copy";
  copies: CopyEntry[];
  close(): void;
  resolve(request: ConflictRequest): Promise<{ copy?: string } | null>;
  notify(message: string): void;
}
interface Other { content: string; diskHash: string }
interface Row { text: string; number: number; changed: boolean }

export function copyLabel(copy: ConflictCopy) {
  const when = new Date(copy.at).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
  if (copy.app === "syncthing") return t("Syncthing, device {{device}}, {{when}}", { device: copy.origin || "?", when });
  if (copy.origin === "draft") return t("Draft kept by Omarkie, {{when}}", { when });
  if (copy.origin === "companion") return t("From the phone companion, {{when}}", { when });
  return t("Disk version kept by Omarkie, {{when}}", { when });
}

// Two read-only panes; lines present on one side only are marked on that side.
function sides(left: string, right: string) {
  const split = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");
  const ours: Row[] = [], theirs: Row[] = [];
  for (const part of diffArrays(split(left), split(right))) {
    for (const text of part.value) {
      if (!part.added) ours.push({ text, number: ours.length + 1, changed: !!part.removed });
      if (!part.removed) theirs.push({ text, number: theirs.length + 1, changed: !!part.added });
    }
  }
  // A replaced line counts once, not once per side.
  return { ours, theirs, changes: Math.max(ours.filter(row => row.changed).length, theirs.filter(row => row.changed).length) };
}

function Pane({ label, detail, rows }: { label: string; detail: string; rows: Row[] }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const first = list.current?.querySelector<HTMLElement>("[data-changed]"), pane = list.current?.parentElement;
    if (first && pane) pane.scrollTop = Math.max(0, first.offsetTop - pane.clientHeight / 3);
  }, [rows]);
  return <section className="version-pane" aria-label={label}>
    <header><strong>{label}</strong><span>{detail}</span></header>
    <div className="version-lines" tabIndex={0} role="region" aria-label={t("{{label}}, text", { label })}>
      <ol ref={list}>{rows.map(row => <li key={row.number} data-changed={row.changed || undefined}>
        <span className="version-number" aria-hidden="true">{row.number}</span><span className="version-text">{row.text || "\u00a0"}</span>
      </li>)}</ol>
    </div>
  </section>;
}

export default function VersionCompare({ record, mode, copies, close, resolve, notify }: Props) {
  const [token, setToken] = useState(copies[0]?.token ?? "");
  const [other, setOther] = useState<Other | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = copies.find(item => item.token === token);
  const dirty = record.content !== record.savedContent;
  useEffect(() => {
    let live = true;
    setOther(null); setError("");
    const load = mode === "disk" ? host.check(record.id).then(change => {
      if (!change?.diskHash || change.content === undefined) throw new Error(t("The disk version is no longer different. Nothing to compare."));
      return { content: change.content, diskHash: change.diskHash };
    }) : host.peek!(token);
    load.then(value => { if (live) setOther(value); }, problem => { if (live) setError(problem instanceof Error ? problem.message : String(problem)); });
    return () => { live = false; };
  }, [mode, record.id, token]);
  const compared = useMemo(() => other && sides(record.content, other.content), [other, record.content]);
  async function choose(request: ConflictRequest, done: (copy?: string) => string) {
    setBusy(true); setError("");
    try {
      const result = await resolve(request);
      notify(done(result?.copy?.split(/[\\/]/).at(-1)));
      close();
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); setBusy(false); }
  }
  const ours = mode === "disk" ? t("Your draft in this window") : t("This note");
  const theirs = mode === "disk" ? t("On disk now") : t("Other version");
  const theirsDetail = mode === "disk" ? t("Changed by another app or a sync") : selected ? copyLabel(selected.copy) : "";
  return <Dialog title={t("Compare versions")} close={() => { if (!busy) close(); }}>
    <div className="version-compare">
      {mode === "copy" && copies.length > 1 && <label className="workspace-field">{t("Other version")}
        <select value={token} disabled={busy} onChange={event => setToken(event.target.value)}>
          {copies.map(item => <option key={item.token} value={item.token}>{copyLabel(item.copy)}</option>)}
        </select>
      </label>}
      <p className="dialog-note" role="status">{compared ? compared.changes ? t("{{count}} lines differ. Changed lines are marked on each side.", { count: compared.changes }) : t("Both versions have the same text.") : error ? "" : t("Reading the other version…")}</p>
      {compared && <div className="version-panes">
        <Pane label={ours} detail={record.name} rows={compared.ours} />
        <Pane label={theirs} detail={theirsDetail} rows={compared.theirs} />
      </div>}
      {error && <p className="version-error" role="alert">{error}</p>}
      <p className="dialog-note">{mode === "disk" ? t("The version you do not keep is saved beside the note as a conflict copy.") : dirty ? t("Save your changes before using the other version.") : t("The version you do not keep goes to the Trash.")}</p>
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={close}>{t("取消")}</button>
        {mode === "disk" ? <>
          <button type="button" disabled={busy || !other} onClick={() => void choose({ action: "keep-disk", text: record.content, diskHash: other!.diskHash },
            copy => t("Loaded the disk version. Your draft is saved as {{name}}.", { name: copy }))}>{t("Use disk version")}</button>
          <button type="button" className="primary-button" disabled={busy || !other} onClick={() => void choose({ action: "keep-draft", text: record.content, diskHash: other!.diskHash },
            copy => t("Kept your draft. The disk version is saved as {{name}}.", { name: copy }))}>{t("Keep my draft")}</button>
        </> : <>
          <button type="button" disabled={busy || !other || dirty || !!record.conflict} onClick={() => void choose({ action: "use-copy", token },
            () => t("Using the other version. The previous note is in the Trash."))}>{t("Use other version")}</button>
          <button type="button" className="primary-button" disabled={busy || !other} onClick={() => void choose({ action: "drop-copy", token },
            () => t("Kept this note. The other version is in the Trash."))}>{t("Keep this note")}</button>
        </>}
      </div>
    </div>
  </Dialog>;
}
