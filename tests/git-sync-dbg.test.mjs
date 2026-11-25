import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GitSync, journalUnion } from "../electron/git-sync-dbg.mjs";
import { SyncTokenStore, keychainState } from "../electron/sync-token.mjs";
import { replayJournalText, visibleMagnets } from "../shared/glass-core.mjs";
import { gitHttpServer } from "./git-http.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const tokenStub = { readToken: async () => null, hasToken: async () => false, keychain: () => ({ available: true, backend: "os", secure: true }) };

test("journal union keeps every distinct line and drops byte duplicates", () => {
  const one = JSON.stringify({ op: "set", magnetId: "m", field: "text", value: "one", hlc: "1-0", device: "a" });
  const two = JSON.stringify({ op: "set", magnetId: "m", field: "text", value: "two", hlc: "2-0", device: "b" });
  assert.equal(journalUnion(`${one}\n`, `${one}\n${two}\n`), `${one}\n${two}\n`);
  assert.equal(journalUnion("", ""), "");
});

test("a token is encrypted in app data and never lands in the vault, settings or journals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-token-"));
  const vault = path.join(root, "vault"), appData = path.join(root, "appdata");
  await mkdir(path.join(vault, ".omarkie", "glass"), { recursive: true });
  await writeFile(path.join(vault, ".omarkie", "glass", "note ~a1b2c3d4.jsonl"), "{}\n");
  const token = "ghp_secret_that_must_never_appear_1234567890";
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: value => Buffer.from([...value].reverse().join(""), "utf8"),
    decryptString: value => [...value.toString("utf8")].reverse().join(""),
  };
  const store = new SyncTokenStore({ file: path.join(appData, "sync-tokens.json"), safeStorage, platform: "linux" });
  const saved = await store.saveToken("vault-1", token, { sessionOnly: false });
  assert.equal(saved.stored, "keychain");
  assert.equal(await store.readToken("vault-1"), token);
  for (const file of ["sync-tokens.json"]) {
    const text = await readFile(path.join(appData, file), "utf8");
    assert.ok(!text.includes(token), `${file} must hold ciphertext only`);
  }
  const journal = await readFile(path.join(vault, ".omarkie", "glass", "note ~a1b2c3d4.jsonl"), "utf8");
  assert.ok(!journal.includes(token));
});

test("basic_text and an unavailable keychain refuse persistence and offer session-only use", async () => {
  for (const [backend, available] of [["basic_text", true], ["unavailable", false]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-token-refuse-"));
    const safeStorage = {
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => backend,
      encryptString: () => Buffer.from("cipher"),
      decryptString: () => "secret",
    };
    const store = new SyncTokenStore({ file: path.join(root, "tokens.json"), safeStorage, platform: "linux" });
    const state = keychainState(safeStorage, "linux");
    assert.equal(state.secure, false);
    await assert.rejects(store.saveToken("vault-1", "secret-token", { sessionOnly: false }), error => error.code === "TOKEN_INSECURE_KEYCHAIN");
    assert.equal(await store.hasToken("vault-1"), false);
    await store.saveToken("vault-1", "secret-token", { sessionOnly: true });
    assert.equal(await store.readToken("vault-1"), "secret-token");
  }
});

test("two journals diverge offline, merge by reader rules and push through a bare remote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-sync-"));
  const remoteRoot = path.join(root, "remote.git"), vaultA = path.join(root, "a"), vaultB = path.join(root, "b"), appData = path.join(root, "appdata");
  git(root, "init", "--bare", remoteRoot);
  git(remoteRoot, "config", "http.receivepack", "true");
  const server = await gitHttpServer(root);
  try {
    for (const vault of [vaultA, vaultB]) {
      await mkdir(path.join(vault, ".omarkie", "glass"), { recursive: true });
      git(vault, "init", "-b", "main");
      git(vault, "config", "user.name", "Test");
      git(vault, "config", "user.email", "test@example.com");
      git(vault, "remote", "add", "origin", `${server.url}/remote.git`);
    }
    const journal = ".omarkie/glass/practice ~a1b2c3d4.jsonl";
    const one = JSON.stringify({ op: "set", magnetId: "m1", field: "text", value: "one", hlc: "1-0", device: "a" });
    await writeFile(path.join(vaultA, journal), `${one}\n`);
    const a = new GitSync({ root: vaultA, appData, tokenStore: tokenStub });
    await a.setRemote(`${server.url}/remote.git`, "main");
    const first = await a.syncNow();
    assert.equal(first.state, "ok");
    assert.equal(first.pushed, true);

    const b = new GitSync({ root: vaultB, appData, tokenStore: tokenStub });
    const pulled = await b.syncNow();
    assert.equal(pulled.state, "ok");
    assert.match(await readFile(path.join(vaultB, journal), "utf8"), /one/);

    const two = JSON.stringify({ op: "set", magnetId: "m2", field: "text", value: "two", hlc: "2-0", device: "b" });
    await appendFile(path.join(vaultA, journal), `${two}\n`);
    await a.syncNow();
    await appendFile(path.join(vaultB, journal), `${JSON.stringify({ op: "set", magnetId: "m3", field: "text", value: "three", hlc: "3-0", device: "b" })}\n`);
    const merged = await b.syncNow();
    assert.equal(merged.state, "ok");
    assert.ok(merged.journals.includes(journal), "journal union is reported");
    const again = await a.syncNow();
    const text = await readFile(path.join(vaultA, journal), "utf8");
    assert.ok(text.includes(two), "A pulled the op written on B");
    assert.ok(text.includes('"m3"'), "A pulled B's offline op");
    const magnets = visibleMagnets(replayJournalText(text).magnets);
    assert.deepEqual(magnets.map(item => item.fields.text).sort(), ["one", "three", "two"]);
  } finally {
    await server.close();
  }
});

test("a non-journal file changed on both sides stops before writing and reports the conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-sync-conflict-"));
  const remoteRoot = path.join(root, "remote.git"), vaultA = path.join(root, "a"), vaultB = path.join(root, "b"), appData = path.join(root, "appdata");
  git(root, "init", "--bare", remoteRoot);
  git(remoteRoot, "config", "http.receivepack", "true");
  const server = await gitHttpServer(root);
  try {
    for (const vault of [vaultA, vaultB]) {
      await mkdir(vault, { recursive: true });
      git(vault, "init", "-b", "main");
      git(vault, "config", "user.name", "Test");
      git(vault, "config", "user.email", "test@example.com");
      git(vault, "remote", "add", "origin", `${server.url}/remote.git`);
    }
    await writeFile(path.join(vaultA, "note.md"), "# One\n");
    const a = new GitSync({ root: vaultA, appData, tokenStore: tokenStub });
    await a.syncNow();
    const b = new GitSync({ root: vaultB, appData, tokenStore: tokenStub });
    await b.syncNow();
    await writeFile(path.join(vaultA, "note.md"), "# One\n\nA edit\n");
    await a.syncNow();
    await writeFile(path.join(vaultB, "note.md"), "# One\n\nB edit\n");
    const result = await b.syncNow();
    assert.equal(result.state, "conflict");
    assert.equal(result.conflicts[0].path, "note.md");
    assert.equal(await readFile(path.join(vaultB, "note.md"), "utf8"), "# One\n\nB edit\n");
  } finally {
    await server.close();
  }
});
