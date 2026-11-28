import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import * as companion from "../companion";
import { resetCompanionImages } from "../host";
import { language, t } from "../i18n";
import "./sync.css";

type Pending = "folder" | "zip" | "forget" | null;

export default function CompanionDialog({ close, notify, mounted }: { close(): void; notify(message: string): void; mounted(): Promise<void> }) {
  const [state, setState] = useState<companion.CompanionStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const folderInput = useRef<HTMLInputElement>(null), zipInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => companion.status().then(setState, problem => setError((problem as Error).message)), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);

  async function run(work: () => Promise<string | null>) {
    setBusy(true); setError(""); setPending(null);
    try {
      const message = await work();
      await resetCompanionImages();
      await mounted();
      await refresh();
      if (message) notify(message);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  function pick(kind: "folder" | "zip") {
    if (state?.changed && pending !== kind) { setPending(kind); return; }
    setPending(null);
    (kind === "folder" ? folderInput : zipInput).current?.click();
  }
  const imported = (count: { notes: number; images: number; skipped: number }) =>
    t("Import finished: notes {{notes}}, photos {{images}}, other files skipped {{skipped}}.", count);
  async function exportChanges() {
    await run(async () => {
      const result = await companion.exportChanges();
      if (!result) return t("No changes to export.");
      const url = URL.createObjectURL(new Blob([result.bytes.slice()], { type: "application/zip" })), anchor = document.createElement("a");
      anchor.href = url; anchor.download = result.name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return t("Exported the changed notes to {{name}}.", { name: result.name });
    });
  }
  const when = (time: number | null) => time ? new Date(time).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" }) : t("Never");

  return <Dialog title={t("Phone companion")} close={() => { if (!busy) close(); }}>
    <div className="companion-dialog">
      <p className="dialog-note">{t("Keeps a copy of one vault in this browser to read, search and edit without a connection. Nothing is uploaded: you choose what comes in and what goes out.")}</p>
      {state === undefined ? <p className="sync-muted" role="status">{t("Reading this device…")}</p> : state ? <dl className="sync-status" aria-label={t("Vault on this device")}>
        <dt>{t("Vault")}</dt><dd>{state.name}</dd>
        <dt>{t("Notes")}</dt><dd>{state.notes}</dd>
        <dt>{t("Photos")}</dt><dd>{state.images}</dd>
        <dt>{t("Imported")}</dt><dd>{when(state.importedAt)}</dd>
        <dt>{t("Last export")}</dt><dd>{when(state.exportedAt)}</dd>
        <dt>{t("Changed, not exported")}</dt><dd>{state.changed}</dd>
      </dl> : <p className="sync-muted" role="status">{t("No vault on this device yet.")}</p>}
      <input ref={folderInput} type="file" multiple hidden onChange={event => { const files = event.target.files; if (files?.length) void run(async () => imported(await companion.importFolder(files))); event.target.value = ""; }} />
      <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void run(async () => imported(await companion.importZip(file))); event.target.value = ""; }} />
      {pending && <p className="sync-warning" role="alert">{pending !== "forget"
        ? t("Some changed notes are not exported yet. Importing replaces them.")
        : state?.changed ? t("Remove this vault from this device? Changes not exported yet are lost.") : t("Remove this vault from this device?")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="dialog-note">{t("Export saves changed notes as conflict copies in a zip. Unzip it into the desktop vault: Omarkie offers to compare each one with its note.")}</p>
      <div className="dialog-actions companion-actions">
        {pending ? <>
          <button type="button" disabled={busy} onClick={() => setPending(null)}>{t("取消")}</button>
          {pending === "forget"
            ? <button type="button" className="primary-button" disabled={busy} onClick={() => void run(async () => { await companion.forget(); return t("Removed the vault from this device."); })}>{t("Remove")}</button>
            : <button type="button" className="primary-button" disabled={busy} onClick={() => pick(pending)}>{t("Replace anyway")}</button>}
        </> : <>
          {state && <button type="button" disabled={busy} onClick={() => setPending("forget")}>{t("Remove from this device")}</button>}
          <button type="button" disabled={busy} onClick={() => pick("folder")}>{t("Import folder…")}</button>
          <button type="button" disabled={busy} onClick={() => pick("zip")}>{t("Import .zip…")}</button>
          {state && <button type="button" className="primary-button" disabled={busy || !state.changed} onClick={() => void exportChanges()}>{t("Export changes")}</button>}
        </>}
      </div>
    </div>
  </Dialog>;
}
