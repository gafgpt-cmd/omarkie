// Git sync must carry every note change, including deletions, and must never carry machine-local
// state: a lock names one process, so syncing it makes the other device read-only and turns every
// concurrent sync into a conflict no person can resolve.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import gitIso from "isomorphic-git";
import httpAdapter from "isomorphic-git/http/node";
import { GitSync, settingsUnion } from "../electron/git-sync.mjs";
import { GlassService } from "../electron/glass-service.mjs";
import { gitHttpServer } from "./git-http.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const tokenStub = { readToken: async () => null, hasToken: async () => false, keychain: () => ({ available: true, backend: "os", secure: true }) };

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-sync-lock-"));
  const remoteRoot = path.join(root, "remote.git");
  git(root, "init", "--bare", remoteRoot);
  git(remoteRoot, "config", "http.receivepack", "true");
  git(remoteRoot, "symbolic-ref", "HEAD", "refs/heads/main");
  const server = await gitHttpServer(root);
  return { root, remoteRoot, server, appData: path.join(root, "appdata") };
}

async function clone(environment, name, files = {}) {
  const vault = path.join(environment.root, name);
  await mkdir(vault, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(vault, file), content);
  git(vault, "init", "-b", "main");
  git(vault, "config", "user.name", "Test");
  git(vault, "config", "user.email", "test@example.com");
  git(vault, "remote", "add", "origin", `${environment.server.url}/remote.git`);
  return vault;
}

const remoteFiles = environment => git(environment.remoteRoot, "ls-tree", "-r", "--name-only", "main").trim().split("\n").filter(Boolean);

test("a note deleted in the vault is deleted on the other device", async () => {
  const environment = await workspace();
  try {
    const vaultA = await clone(environment, "a", { "note.md": "# One\n", "other.md": "# Two\n" });
    const a = new GitSync({ root: vaultA, appData: environment.appData, tokenStore: tokenStub });
    await a.setRemote(`${environment.server.url}/remote.git`, "main");
    assert.equal((await a.syncNow()).state, "ok");

    const vaultB = await clone(environment, "b");
    const b = new GitSync({ root: vaultB, appData: environment.appData, tokenStore: tokenStub });
    assert.equal((await b.syncNow()).state, "ok");
    assert.equal(await readFile(path.join(vaultB, "other.md"), "utf8"), "# Two\n");

    await unlink(path.join(vaultA, "other.md"));
    const pushed = await a.syncNow();
    assert.equal(pushed.state, "ok");
    assert.equal(pushed.pushed, true);
    assert.deepEqual(remoteFiles(environment).filter(file => file.endsWith(".md")).sort(), ["note.md"], "the deletion reached the remote");
    assert.equal((await a.status()).changed, 0, "the deletion is committed, not left pending forever");

    const pulled = await b.syncNow();
    assert.equal(pulled.state, "ok");
    await assert.rejects(stat(path.join(vaultB, "other.md")), { code: "ENOENT" }, "the other device deleted it too");
    assert.equal((await b.status()).changed, 0);
  } finally { await environment.server.close(); }
});

test("the writer lock is never pushed and two devices keep one vault id", async () => {
  const environment = await workspace();
  const note = "# Map\n\nContour lines close together mean a steep slope.\n";
  const services = [];
  try {
    const vaultA = await clone(environment, "a", { "map.md": note });
    const vaultB = await clone(environment, "b", { "map.md": note });
    const a = await new GlassService({ root: vaultA, appData: path.join(environment.root, "app-a"), device: "dev-a", host: "laptop-a" }).open();
    const b = await new GlassService({ root: vaultB, appData: path.join(environment.root, "app-b"), device: "dev-b", host: "laptop-b" }).open();
    services.push(a, b);
    await a.request({ action: "add", note: "map.md", magnet: "m-a", text: "from a" });
    await b.request({ action: "add", note: "map.md", magnet: "m-b", text: "from b" });

    const syncA = new GitSync({ root: vaultA, appData: path.join(environment.root, "app-a"), service: a, tokenStore: tokenStub });
    const syncB = new GitSync({ root: vaultB, appData: path.join(environment.root, "app-b"), service: b, tokenStore: tokenStub });
    await syncA.setRemote(`${environment.server.url}/remote.git`, "main");
    await syncB.setRemote(`${environment.server.url}/remote.git`, "main");

    assert.equal((await syncA.syncNow()).state, "ok");
    const pulled = await syncB.syncNow();
    assert.equal(pulled.state, "ok", `the second device must sync, not conflict: ${JSON.stringify(pulled.conflicts)}`);
    assert.deepEqual(pulled.conflicts, []);
    assert.ok(!remoteFiles(environment).some(file => file.endsWith("writer.lock")), "no machine-local lock is committed");
    const again = await syncA.syncNow();
    assert.equal(again.state, "ok");

    const settings = await Promise.all([vaultA, vaultB].map(vault => readFile(path.join(vault, ".omarkie", "settings.json"), "utf8").then(JSON.parse)));
    assert.equal(settings[0].vaultId, settings[1].vaultId, "both devices agree on the vault's identity");
    assert.deepEqual(await readFile(path.join(vaultB, ".omarkie", "writer.lock"), "utf8").then(JSON.parse).then(lock => lock.host), "laptop-b",
      "the running device keeps its own claim");

    await b.reloadStore();
    const added = await b.request({ action: "add", note: "map.md", magnet: "m-b2", text: "after sync" });
    assert.equal(added.saved, true, "the second device is still writable after syncing");
  } finally {
    for (const service of services) await service.close().catch(() => {});
    await environment.server.close();
  }
});

test("a lock committed by another machine never replaces this machine's claim", async () => {
  const environment = await workspace();
  const note = "# Map\n\nContour lines.\n";
  let service;
  try {
    const vaultA = await clone(environment, "a", { "map.md": note });
    const vaultB = await clone(environment, "b", { "map.md": note });
    const a = await new GlassService({ root: vaultA, appData: path.join(environment.root, "app-a"), device: "dev-a", host: "laptop-a" }).open();
    service = await new GlassService({ root: vaultB, appData: path.join(environment.root, "app-b"), device: "dev-b", host: "laptop-b" }).open();
    await a.request({ action: "add", note: "map.md", magnet: "m-a", text: "from a" });
    await service.request({ action: "add", note: "map.md", magnet: "m-b", text: "from b" });
    const syncA = new GitSync({ root: vaultA, appData: path.join(environment.root, "app-a"), service: a, tokenStore: tokenStub });
    const syncB = new GitSync({ root: vaultB, appData: path.join(environment.root, "app-b"), service, tokenStore: tokenStub });
    await syncA.setRemote(`${environment.server.url}/remote.git`, "main");
    await syncB.setRemote(`${environment.server.url}/remote.git`, "main");
    assert.equal((await syncA.syncNow()).state, "ok");

    // A lock left in the repository by an older build or by hand; it must never reach another machine.
    const foreign = JSON.stringify({ version: 1, host: "laptop-a", pid: 1, token: "foreign", started: Date.now() });
    await writeFile(path.join(vaultA, ".omarkie", "writer.lock"), foreign);
    await gitIso.add({ fs: nodeFs, dir: vaultA, filepath: ".omarkie/writer.lock" });
    await gitIso.commit({ fs: nodeFs, dir: vaultA, message: "an old build committed its lock", author: { name: "T", email: "t@e" } });
    await gitIso.push({ fs: nodeFs, http: httpAdapter, dir: vaultA, url: `${environment.server.url}/remote.git`, remote: "origin", ref: "main" });
    assert.ok(remoteFiles(environment).includes(".omarkie/writer.lock"), "the repository really holds a lock");

    const pulled = await syncB.syncNow();
    assert.equal(pulled.state, "ok");
    const claim = JSON.parse(await readFile(path.join(vaultB, ".omarkie", "writer.lock"), "utf8"));
    assert.equal(claim.host, "laptop-b", "the running device's claim is untouched");
    assert.equal(claim.token, service.lockToken);
    assert.equal(service.readOnly, false);
  } finally {
    await service?.close().catch(() => {});
    await environment.server.close();
  }
});

test("settings merge keeps one identity and refuses a conflicting remote", () => {
  const older = { version: 1, vaultId: "aaaaaaaa-1111", mode: "inside", createdAt: "2026-01-01T00:00:00.000Z" };
  const newer = { version: 1, vaultId: "bbbbbbbb-2222", mode: "inside", createdAt: "2026-02-01T00:00:00.000Z" };
  const merged = JSON.parse(settingsUnion(JSON.stringify(older), JSON.stringify(newer)));
  assert.equal(merged.vaultId, older.vaultId, "the earliest creator names the vault");
  assert.equal(merged.createdAt, older.createdAt);
  assert.equal(JSON.parse(settingsUnion(JSON.stringify(newer), JSON.stringify(older))).vaultId, older.vaultId, "either argument order agrees");
  const withSync = JSON.parse(settingsUnion(JSON.stringify({ ...older, sync: { remote: "https://example.test/v.git", branch: "main" } }),
    JSON.stringify({ ...newer, sync: { remote: "https://other.test/v.git", branch: "main" } })));
  assert.equal(withSync, null, "a different remote still needs a person");
  assert.equal(settingsUnion("{", "{}"), null);
});
