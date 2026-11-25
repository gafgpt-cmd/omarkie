// Git sync for a vault the user already made a repository. One job at a time under the service's
// single-writer lock: commit local glass ops, fetch, merge journals by reader rules, push, retry once.
// isomorphic-git talks HTTP only; tokens come from the OS keychain and never enter files or results.

import nodeFs from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import git from "isomorphic-git";
import httpAdapter from "isomorphic-git/http/node";
import { detectFolderSync } from "./folder-sync.mjs";
import { tokenError } from "./sync-token.mjs";

const journalPath = /(^|\/)\.omarkie\/.+\.jsonl$/;
const running = new Map();

export function journalUnion(local, remote) {
  const seen = new Set();
  const lines = [];
  for (const text of [local, remote]) {
    for (const line of String(text ?? "").split(/\r?\n/)) {
      if (!line) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function classify(error) {
  if (!error || !error.code) return error;
  if (String(error.code).startsWith("TOKEN_")) return error;
  if (error.code === "HttpError") {
    if (error.data?.statusCode === 401 || error.data?.statusCode === 403) {
      return syncError("SYNC_AUTH", "Remote refused the token. Save a current token in Sync settings.");
    }
    if (error.data?.statusCode === 404) return syncError("SYNC_REMOTE_NOT_FOUND", "Remote repository was not found.");
    return syncError("SYNC_HTTP", `Remote returned HTTP ${error.data?.statusCode ?? "error"}.`);
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code)) {
    return syncError("SYNC_OFFLINE", "Remote is unreachable. Work stays local; try again when online.");
  }
  if (/Failed to fetch|network|socket hang up/i.test(error.message ?? "")) {
    return syncError("SYNC_OFFLINE", "Remote is unreachable. Work stays local; try again when online.");
  }
  return error;
}

function safeRemote(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) throw syncError("SYNC_REMOTE_UNSAFE", "Remove the user name or token from the remote URL.");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw syncError("SYNC_REMOTE_UNSUPPORTED", "Sync needs an HTTPS git remote. Set one in Sync settings.");
    }
    return { url: url.toString(), display: url.toString() };
  } catch (error) {
    if (error.code) throw error;
    throw syncError("SYNC_REMOTE_INVALID", "Remote is not a valid HTTPS URL.");
  }
}

export class GitSync {
  constructor({ root, appData, service = null, tokenStore, http = httpAdapter, fs = null, now = () => new Date() }) {
    if (!root || !appData || !tokenStore) throw new Error("Git sync needs a vault, app data and a token store.");
    this.root = root;
    this.appData = appData;
    this.service = service;
    this.tokens = tokenStore;
    this.http = http;
    this.fs = fs;
    this.now = now;
    this.id = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
    this.settingsFile = path.join(root, ".omarkie", "settings.json");
    this.stateFile = path.join(appData, "sync-state", `${this.id}.json`);
  }

  async #state() {
    try {
      const value = JSON.parse(await readFile(this.stateFile, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async #saveState(last) {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify({ last }, null, 2)}\n`, "utf8");
    await rename(temp, this.stateFile);
  }

  async #repo() {
    try {
      const metadata = await lstat(path.join(this.root, ".git"));
      return metadata.isDirectory() || metadata.isFile();
    } catch {
      return false;
    }
  }

  async #atRoot() {
    if (!await this.#repo()) return false;
    try {
      return path.resolve(await git.findRoot({ fs: this.fs ?? nodeFs, filepath: this.root })) === path.resolve(this.root);
    } catch {
      return false;
    }
  }

  async #settings() {
    let text;
    try {
      text = await readFile(this.settingsFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw syncError("SYNC_SETTINGS_INVALID", "Vault settings.json is not valid JSON; fix it before syncing.");
    }
  }

  async #saveSettings(next) {
    await mkdir(path.dirname(this.settingsFile), { recursive: true });
    const temp = `${this.settingsFile}.sync-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, this.settingsFile);
  }

  async setRemote(remote, branch = null) {
    if (!remote || typeof remote !== "string") throw syncError("SYNC_REMOTE_INVALID", "Paste the HTTPS remote first.");
    const clean = safeRemote(remote.trim());
    if (branch !== null && !/^[A-Za-z0-9._\/-]+$/.test(branch)) throw syncError("SYNC_BRANCH_INVALID", "Branch name is not valid.");
    const settings = await this.#settings();
    settings.sync = { ...(settings.sync ?? {}), remote: clean.url, ...(branch ? { branch } : {}) };
    await this.#saveSettings(settings);
    return { remote: clean.display, branch: branch ?? settings.sync.branch ?? null };
  }

  async saveToken(token, { remember = true } = {}) {
    return this.tokens.saveToken(this.id, token, { sessionOnly: !remember });
  }

  async clearToken() {
    return this.tokens.clearToken(this.id);
  }

  async #remoteInfo() {
    const settings = await this.#settings();
    const configured = settings.sync?.remote ?? null;
    let origin = null;
    try {
      origin = await git.getConfig({ fs: this.fs ?? nodeFs, dir: this.root, path: "remote.origin.url" });
    } catch {
      origin = null;
    }
    const chosen = configured ?? origin;
    if (!chosen) return { configured: null, origin, branch: settings.sync?.branch ?? null };
    const clean = safeRemote(chosen);
    let branch = settings.sync?.branch ?? null;
    if (!branch) {
      branch = await git.currentBranch({ fs: this.fs ?? nodeFs, dir: this.root, fullname: false }).catch(() => null);
    }
    return { configured: clean, origin, branch: branch || null, settings };
  }

  async status() {
    const repo = await this.#atRoot();
    const folderSync = await detectFolderSync(this.root).catch(() => null);
    if (!repo) return { repo: false, folderSync, hasToken: await this.tokens.hasToken(this.id), keychain: this.tokens.keychain(), changed: 0, last: null };
    const info = await this.#remoteInfo().catch(() => null);
    const changed = await this.#changedCount().catch(() => 0);
    return {
      repo: true,
      folderSync,
      remote: info?.configured?.display ?? null,
      origin: info?.origin ? safeRemoteOrNull(info.origin) : null,
      branch: info?.branch ?? null,
      hasToken: await this.tokens.hasToken(this.id),
      keychain: this.tokens.keychain(),
      changed,
      last: await this.#state().then(value => value?.last ?? null),
    };
  }

  async #changedCount() {
    const rows = await git.statusMatrix({ fs: this.fs ?? nodeFs, dir: this.root });
    return rows.filter(([, head, work, stage]) => head !== work || work !== stage).length;
  }

  async #head() {
    try {
      return await git.resolveRef({ fs: this.fs ?? nodeFs, dir: this.root, ref: "HEAD" });
    } catch {
      return null;
    }
  }

  async #assertWritable() {
    if (!await this.#atRoot()) throw syncError("SYNC_NOT_REPO", "This vault is not a git repository at its root. Set one up in git first.");
    if (this.service?.readOnly) throw syncError("SYNC_READ_ONLY", "This vault is open read-only. Close the other window or wait for it to finish.");
    for (const filepath of [".omarkie/settings.json", ".omarkie/glass", ".omarkie/assets/boards", ".omarkie/notes.jsonl"]) {
      if (await git.isIgnored({ fs: this.fs ?? nodeFs, dir: this.root, filepath })) {
        throw syncError("SYNC_IGNORED", "Git ignores part of .omarkie, so glass ops or boards cannot sync. Remove it from .gitignore first.");
      }
    }
  }

  async #author() {
    const name = await git.getConfig({ fs: this.fs ?? nodeFs, dir: this.root, path: "user.name" }).catch(() => null);
    const email = await git.getConfig({ fs: this.fs ?? nodeFs, dir: this.root, path: "user.email" }).catch(() => null);
    return { name: name || "omarkie", email: email || "omarkie@localhost" };
  }

  async #commitLocal() {
    const rows = await git.statusMatrix({ fs: this.fs ?? nodeFs, dir: this.root });
    const changed = rows.filter(([, head, work, stage]) => head !== work || work !== stage).length;
    if (!changed) return { committed: false, changed: 0 };
    await git.add({ fs: this.fs ?? nodeFs, dir: this.root, filepath: "." });
    const author = await this.#author();
    const oid = await git.commit({ fs: this.fs ?? nodeFs, dir: this.root, message: "omarkie: sync local glass ops", author });
    return { committed: true, changed, oid };
  }

  async #fetch(branch, { shallow = false, single = true } = {}) {
    const info = await this.#remoteInfo();
    if (!info.origin) throw syncError("SYNC_NO_ORIGIN", "This repository has no origin remote. Add one in git, then try again.");
    if (!info.configured) {
      throw syncError("SYNC_REMOTE_UNSUPPORTED", "The repository remote is not HTTPS. Set an HTTPS remote in Sync settings.");
    }
    const token = await this.tokens.readToken(this.id);
    const auth = token ? () => ({ username: "omarkie", password: token }) : undefined;
    try {
      return await git.fetch({
        fs: this.fs ?? nodeFs,
        http: this.http,
        dir: this.root,
        url: info.configured.url,
        remote: "origin",
        // An unborn local branch cannot resolve HEAD, so the first pull asks for every branch.
        ref: branch,
        remoteRef: branch,
        ...(single ? { singleBranch: true } : {}),
        depth: shallow ? 1 : undefined,
        onAuth: auth,
      });
    } catch (error) {
      throw classify(error);
    }
  }

  async #writeRemoteRefs(branch, oid) {
    await git.writeRef({ fs: this.fs ?? nodeFs, dir: this.root, ref: `refs/heads/${branch}`, value: oid, force: true });
    await git.writeRef({ fs: this.fs ?? nodeFs, dir: this.root, ref: `refs/remotes/origin/${branch}`, value: oid, force: true });
  }

  async #fastForward(branch, oid) {
    await this.#writeRemoteRefs(branch, oid);
    await git.checkout({ fs: this.fs ?? nodeFs, dir: this.root, ref: branch, force: true });
  }

  async #tree(oid) {
    const map = new Map();
    if (!oid) return map;
    await git.walk({
      fs: this.fs ?? nodeFs,
      dir: this.root,
      trees: [git.TREE({ ref: oid })],
      map: async (filepath, [entry]) => {
        if (!entry) return undefined;
        // TREE entries expose lazy fields in this isomorphic-git release.
        const type = typeof entry.type === "function" ? await entry.type() : entry.type;
        if (type !== "blob") return undefined;
        const oid = typeof entry.oid === "function" ? await entry.oid() : entry.oid;
        const mode = typeof entry.mode === "function" ? await entry.mode() : entry.mode;
        map.set(filepath, { oid, mode });
        return undefined;
      },
    });
    return map;
  }

  async #readBlob(oid) {
    const { blob } = await git.readBlob({ fs: this.fs ?? nodeFs, dir: this.root, oid });
    return Buffer.from(blob);
  }

  // Returns decisions before touching the working tree, so a conflict in a note never half-applies images.
  async #merge(localOid, remoteOid) {
    const bases = await git.findMergeBase({ fs: this.fs ?? nodeFs, dir: this.root, oids: [localOid, remoteOid] }).catch(() => null);
    const baseOid = Array.isArray(bases) ? bases[0] : bases;
    const [base, local, remote] = await Promise.all([this.#tree(baseOid), this.#tree(localOid), this.#tree(remoteOid)]);
    const writes = new Map();
    const deletes = new Set();
    const conflicts = [];
    const journals = [];
    const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
    for (const filepath of paths) {
      const b = base.get(filepath);
      const l = local.get(filepath);
      const r = remote.get(filepath);
      const same = (x, y) => x?.oid === y?.oid;
      if (same(l, r)) continue;
      if (!l) {
        if (!b) { writes.set(filepath, await this.#readBlob(r.oid)); continue; }
        if (same(b, r)) { continue; }
        conflicts.push({ path: filepath, reason: "deleted locally, changed remotely" });
        continue;
      }
      if (!r) {
        if (!b || same(b, l)) { deletes.add(filepath); continue; }
        conflicts.push({ path: filepath, reason: "changed locally, deleted remotely" });
        continue;
      }
      if (same(b, l)) { writes.set(filepath, await this.#readBlob(r.oid)); continue; }
      if (same(b, r)) continue;
      if (journalPath.test(filepath)) {
        let localText = null;
        try { localText = await readFile(path.join(this.root, ...filepath.split("/")), "utf8"); } catch { localText = null; }
        if (localText === null) localText = (await this.#readBlob(l.oid)).toString("utf8");
        const remoteText = (await this.#readBlob(r.oid)).toString("utf8");
        writes.set(filepath, Buffer.from(journalUnion(localText, remoteText), "utf8"));
        journals.push(filepath);
        continue;
      }
      conflicts.push({ path: filepath, reason: "changed on both sides" });
    }
    if (conflicts.length) return { conflicts, writes: new Map(), deletes: new Set(), journals: [], merged: false };
    for (const filepath of deletes) {
      await unlink(path.join(this.root, ...filepath.split("/"))).catch(error => { if (error.code !== "ENOENT") throw error; });
      await git.remove({ fs: this.fs ?? nodeFs, dir: this.root, filepath });
    }
    for (const [filepath, content] of writes) {
      const target = path.join(this.root, ...filepath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    if (writes.size) await git.add({ fs: this.fs ?? nodeFs, dir: this.root, filepath: "." });
    return { conflicts: [], writes, deletes, journals, merged: true };
  }

  async #mergeCommit(branch, localOid, remoteOid) {
    const merged = await this.#merge(localOid, remoteOid);
    if (merged.conflicts.length) {
      return { state: "conflict", conflicts: merged.conflicts, pulled: 0, journals: [], pushed: false };
    }
    if (!merged.writes.size && !merged.deletes.size) {
      await this.#fastForward(branch, remoteOid);
      return { state: "ok", conflicts: [], pulled: 0, journals: [], pushed: false };
    }
    const author = await this.#author();
    await git.commit({
      fs: this.fs ?? nodeFs,
      dir: this.root,
      message: `omarkie: merge remote glass ops${merged.journals.length ? ` (${merged.journals.length} journal${merged.journals.length === 1 ? "" : "s"})` : ""}`,
      author,
      parent: [localOid, remoteOid],
    });
    return { state: "ok", conflicts: [], pulled: merged.writes.size, journals: merged.journals, pushed: true };
  }

  async #push(branch) {
    const info = await this.#remoteInfo();
    if (!info.origin) throw syncError("SYNC_NO_ORIGIN", "This repository has no origin remote. Add one in git, then try again.");
    if (!info.configured) throw syncError("SYNC_REMOTE_UNSUPPORTED", "The repository remote is not HTTPS. Set an HTTPS remote in Sync settings.");
    const token = await this.tokens.readToken(this.id);
    const auth = token ? () => ({ username: "omarkie", password: token }) : undefined;
    try {
      const result = await git.push({
        fs: this.fs ?? nodeFs,
        http: this.http,
        dir: this.root,
        url: info.configured.url,
        remote: "origin",
        ref: branch,
        onAuth: auth,
      });
      if (result.ok === false) throw syncError("SYNC_PUSH", result.error || "Push was refused.");
      return result;
    } catch (error) {
      throw classify(error);
    }
  }

  async #retryPush(branch) {
    try {
      return await this.#push(branch);
    } catch (error) {
      if (error.code === "SYNC_AUTH" || error.code === "SYNC_OFFLINE" || error.code === "SYNC_REMOTE_NOT_FOUND") throw error;
      const fetched = await this.#fetch(branch);
      if (!fetched?.fetchHead) throw error;
      const local = await this.#head();
      if (local === fetched.fetchHead) {
        return await this.#push(branch);
      }
      const remoteAhead = await git.isDescendent({ fs: this.fs ?? nodeFs, dir: this.root, oid: fetched.fetchHead, ancestor: local }).catch(() => false);
      const merged = await this.#mergeCommit(branch, local, fetched.fetchHead);
      if (merged.state === "conflict") {
        const conflictError = syncError("SYNC_CONFLICT", "Remote advanced while pushing and a note conflicts. Resolve it in git, then sync again.");
        conflictError.conflicts = merged.conflicts;
        throw conflictError;
      }
      if (remoteAhead && !merged.pushed) return { ok: true, retried: true };
      return await this.#push(branch);
    }
  }

  // The remote, not a guess, decides the branch: its HEAD symref first, then its only branch.
  async #remoteBranch(preferred) {
    const info = await this.#remoteInfo();
    if (!info.configured) return preferred;
    const token = await this.tokens.readToken(this.id);
    const auth = token ? () => ({ username: "omarkie", password: token }) : undefined;
    let refs;
    try {
      refs = await git.listServerRefs({ http: this.http, url: info.configured.url, symrefs: true, onAuth: auth });
    } catch (error) {
      throw classify(error);
    }
    const heads = refs.filter(ref => typeof ref.ref === "string" && ref.ref.startsWith("refs/heads/")).map(ref => ref.ref.slice("refs/heads/".length));
    if (heads.includes(preferred)) return preferred;
    const head = refs.find(ref => ref.ref === "HEAD")?.symrefTarget?.replace(/^refs\/heads\//u, "");
    if (head && heads.includes(head)) return head;
    return heads.length === 1 ? heads[0] : preferred;
  }

  async #firstPull(branch) {
    const target = await this.#remoteBranch(branch);
    const fetched = await this.#fetch(target, { shallow: true, single: false });
    if (!fetched?.fetchHead) return { pulled: 0, empty: true, branch: target };
    await this.#fastForward(target, fetched.fetchHead);
    const tree = await this.#tree(fetched.fetchHead);
    return { pulled: tree.size, oid: fetched.fetchHead, branch: target };
  }

  async syncNow() {
    const key = this.id;
    if (running.has(key)) throw syncError("SYNC_BUSY", "A sync is already running for this vault.");
    const job = this.#run().catch(async error => {
      await this.#recordFailure(error);
      throw error;
    }).finally(() => running.delete(key));
    running.set(key, job);
    return job;
  }

  async #run() {
    await this.#assertWritable();
    await this.service?.flushPending?.();
    const info = await this.#remoteInfo();
    if (!info.origin) throw syncError("SYNC_NO_ORIGIN", "This repository has no origin remote. Add one in git, then try again.");
    if (!info.configured) throw syncError("SYNC_REMOTE_UNSUPPORTED", "The repository remote is not HTTPS. Set an HTTPS remote in Sync settings.");
    if (!info.branch) throw syncError("SYNC_NO_BRANCH", "Check out a branch before syncing.");
    let branch = info.branch;
    await this.#commitLocal();
    const local = await this.#head();
    let result;
    let needsPush = false;
    if (!local) {
      const pulled = await this.#firstPull(branch);
      branch = pulled.branch ?? branch;
      result = { state: "ok", conflicts: [], pulled: pulled.pulled, journals: [], message: pulled.empty ? "Remote is empty." : "Pulled the vault." };
    } else {
      const fetched = await this.#fetch(branch);
      const remoteOid = fetched.fetchHead;
      if (!remoteOid) {
        needsPush = true;
        result = { state: "ok", conflicts: [], pulled: 0, journals: [], message: "Remote is empty." };
      } else if (remoteOid === local) {
        result = { state: "ok", conflicts: [], pulled: 0, journals: [], message: "Already up to date." };
      } else {
        const localContainsRemote = await git.isDescendent({ fs: this.fs ?? nodeFs, dir: this.root, oid: local, ancestor: remoteOid }).catch(() => false);
        const remoteContainsLocal = await git.isDescendent({ fs: this.fs ?? nodeFs, dir: this.root, oid: remoteOid, ancestor: local }).catch(() => false);
        if (remoteContainsLocal) {
          await this.#fastForward(branch, remoteOid);
          const tree = await this.#tree(remoteOid);
          result = { state: "ok", conflicts: [], pulled: tree.size, journals: [], message: "Pulled remote changes." };
        } else if (localContainsRemote) {
          needsPush = true;
          result = { state: "ok", conflicts: [], pulled: 0, journals: [], message: "Pushed local changes." };
        } else {
          result = await this.#mergeCommit(branch, local, remoteOid);
          needsPush = result.state !== "conflict" && result.pushed;
          result.message = result.state === "conflict"
            ? "Conflicts need a person: resolve them in git, commit, then sync again."
            : `${result.pulled} files merged${result.journals.length ? `, ${result.journals.length} journals unioned` : ""}.`;
        }
      }
    }
    if (needsPush) {
      await this.#retryPush(branch);
      result.pushed = true;
    }
    const last = {
      state: result.state,
      at: this.now().toISOString(),
      message: result.message,
      conflicts: result.conflicts ?? [],
      pulled: result.pulled ?? 0,
      journals: result.journals?.length ?? 0,
      pushed: Boolean(result.pushed),
    };
    await this.#saveState(last);
    return {
      state: result.state,
      message: result.message,
      pulled: result.pulled ?? 0,
      journals: result.journals ?? [],
      conflicts: result.conflicts ?? [],
      pushed: Boolean(result.pushed),
      last,
    };
  }

  async #recordFailure(error) {
    if (!await this.#repo()) return;
    await this.#saveState({
      state: "error",
      at: this.now().toISOString(),
      message: error?.message ?? "Sync failed.",
      conflicts: [],
      pulled: 0,
      journals: 0,
      pushed: false,
    }).catch(() => {});
  }
}

function safeRemoteOrNull(value) {
  try { return safeRemote(value).display; } catch { return null; }
}

// Kept for callers that need the exact token error codes without importing the store.
export { tokenError };
