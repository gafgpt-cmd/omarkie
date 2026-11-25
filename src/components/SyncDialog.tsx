import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Dialog } from "./Dialog";
import { host } from "../host";
import { t } from "../i18n";
import "./sync.css";

interface Keychain { available: boolean; backend: string; secure: boolean }
interface LastResult { state?: string; at?: string; message?: string; conflicts?: { path: string; reason: string }[]; pulled?: number; journals?: number; pushed?: boolean }
interface SyncStatus {
  repo: boolean; folderSync?: { app: string; source: string } | null; remote?: string | null; origin?: string | null;
  branch?: string | null; hasToken: boolean; keychain: Keychain; changed: number; last?: LastResult | null;
}
interface SyncResult { state: string; message?: string; pulled?: number; journals?: string[]; conflicts?: { path: string; reason: string }[]; pushed?: boolean; last?: LastResult }

export default function SyncDialog({ close, notify }: { close(): void; notify(message: string): void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<SyncResult | null>(null);
  const touched = useRef(false);

  const refresh = useCallback(async () => {
    const next = await host.sync!({ action: "status" }) as SyncStatus;
    setStatus(next);
    if (!touched.current) {
      setRemote(next.remote ?? "");
      setBranch(next.branch ?? "");
    }
    return next;
  }, []);

  useEffect(() => { void refresh().catch(error => setError((error as Error).message)); }, [refresh]);

  const act = useCallback(async (action: string, extra: Record<string, unknown>, label: string) => {
    setBusy(label);
    setError("");
    try {
      const value = await host.sync!({ action, ...extra });
      if (action === "now") { setResult(value as SyncResult); notify((value as SyncResult).message ?? t("Sync finished.")); }
      await refresh();
      return value;
    } catch (problem) {
      const failure = problem as Error & { conflicts?: { path: string; reason: string }[] };
      setError(failure.message);
      if (Array.isArray(failure.conflicts)) setResult({ state: "conflict", conflicts: failure.conflicts, message: failure.message });
      return null;
    } finally {
      setBusy("");
    }
  }, [notify, refresh]);

  const saveRemote = () => act("configure", { remote, branch: branch.trim() || null }, "remote").then(value => {
    if (value) notify(t("Remote saved."));
  });
  const saveToken = () => act("token", { token, remember: remember && !insecure }, "token").then(value => {
    if (value) { setToken(""); notify(remember && !insecure ? t("Token saved in the OS keychain.") : t("Token is valid for this session only.")); }
  });
  const syncNow = () => act("now", {}, "sync");
  const clearToken = () => act("clear-token", {}, "clear").then(value => { if (value) notify(t("Token removed.")); });

  const keychain = status?.keychain;
  const insecure = keychain && (!keychain.secure || keychain.backend === "basic_text");
  const conflicts = result?.conflicts?.length ? result.conflicts : status?.last?.conflicts ?? [];
  const last = status?.last;

  return <Dialog title={t("Sync")} close={close}>
    <div className="sync-status" data-testid="sync-status">
      {!status ? <span className="sync-muted">{t("Reading repository…")}</span> : !status.repo ? <p className="sync-warning">{t("This folder is not a git repository. Set one up in git, then reopen the folder.")}</p> : <>
        <p><strong>{status.remote ? t("Remote: {{remote}}", { remote: status.remote }) : t("Remote: set an HTTPS remote below")}</strong></p>
        <p className="sync-muted">{t("Branch: {{branch}}", { branch: status.branch || t("not checked out") })} · {status.hasToken ? t("Token saved") : t("No token saved")} · {t("{{count}} local changes", { count: status.changed })}</p>
        {status.folderSync && <p className="sync-muted">{t("Synced by {{app}}", { app: status.folderSync.app })}</p>}
      </>}
      {last && <p className="sync-last" data-state={last.state}>{last.state === "conflict" ? t("Last sync needs attention: {{message}}", { message: last.message ?? "" }) : last.state === "error" ? t("Last sync failed: {{message}}", { message: last.message ?? "" }) : t("Last sync: {{message}}", { message: last.message ?? t("finished") })}</p>}
    </div>

    {status?.repo && <>
      <label className="workspace-field">{t("HTTPS git remote")}
        <input aria-label={t("HTTPS git remote")} value={remote} placeholder="https://github.com/you/vault.git" onChange={event => { touched.current = true; setRemote(event.target.value); }} />
      </label>
      <label className="workspace-field">{t("Branch")}
        <input aria-label={t("Branch")} value={branch} placeholder="main" onChange={event => { touched.current = true; setBranch(event.target.value); }} />
      </label>
      <div className="sync-row"><button type="button" disabled={!!busy || !remote.trim()} onClick={() => void saveRemote()}>{t("Save remote")}</button></div>

      <fieldset className="sync-token">
        <legend>{t("Access token")}</legend>
        <p className="sync-muted">{t("The token is only used for this remote. It is never written to the vault, settings, logs or the journal.")}</p>
        {insecure && <p className="sync-warning" role="alert">{keychain?.backend === "basic_text"
          ? t("Your keychain backend is basic_text, which stores secrets in plain text. Remember is off; use the token for this session only, or unlock a system keyring.")
          : t("The OS keychain is unavailable. Remember is off; use the token for this session only, or unlock a system keyring.")}</p>}
        <input aria-label={t("Access token")} type="password" autoComplete="off" value={token} placeholder={status.hasToken ? t("Saved · paste a new token to replace it") : t("Paste a personal access token")} onChange={event => setToken(event.target.value)} />
        <label className="checkbox-option"><input type="checkbox" checked={remember && !insecure} disabled={!!insecure} onChange={event => setRemember(event.target.checked)} />{t("Remember in the OS keychain")}</label>
        <div className="sync-row">
          <button type="button" disabled={!!busy || !token.trim()} onClick={() => void saveToken()}>{remember && !insecure ? t("Save token") : t("Use for this session")}</button>
          {status.hasToken && <button type="button" disabled={!!busy} onClick={() => void clearToken()}>{t("Forget token")}</button>}
        </div>
      </fieldset>
    </>}

    {conflicts.length > 0 && <div className="sync-conflicts" role="alert">
      <strong>{t("Conflicts")}</strong>
      <ul>{conflicts.map(item => <li key={item.path}><code>{item.path}</code> — {item.reason}</li>)}</ul>
      <p className="sync-muted">{t("Resolve them in git, commit, then sync again. Journals merge by reader rules; notes and other files wait for a person.")}</p>
    </div>}

    {error && <p className="sync-warning" role="alert">{error}</p>}

    <div className="dialog-actions sync-actions">
      <button type="button" className="primary-button" data-testid="sync-now" disabled={!!busy || !status?.repo || !status?.remote} onClick={() => void syncNow()}>
        {busy === "sync" ? <Loader2 size={15} className="sync-spin" /> : <Cloud size={15} />}{busy === "sync" ? t("Syncing…") : t("Sync now")}
      </button>
      <button type="button" onClick={close}>{t("Close")}</button>
    </div>
    {busy && busy !== "sync" && <p className="sync-muted" role="status"><Loader2 size={13} className="sync-spin" /> {t("Saving…")}</p>}
  </Dialog>;
}
