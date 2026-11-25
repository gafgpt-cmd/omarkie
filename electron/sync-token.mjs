// Vault access tokens live in the OS keychain through Electron safeStorage and nowhere else.
// On Linux the keyring can degrade to `basic_text`; that backend is plaintext-equivalent, so we refuse
// to persist a token there and offer session-only use instead. Ciphertext never leaves app data.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const empty = () => ({ version: 1, vaults: {} });

export function keychainState(safeStorage, platform = process.platform) {
  const available = Boolean(safeStorage?.isEncryptionAvailable?.());
  let backend = platform === "linux" ? safeStorage?.getSelectedStorageBackend?.() ?? "unknown" : "os";
  if (!available) backend = "unavailable";
  const secure = available && backend !== "basic_text" && !(platform === "linux" && backend === "unknown");
  return { available, backend, secure };
}

export class SyncTokenStore {
  #file;
  #safeStorage;
  #platform;
  #session = new Map();
  #loaded;

  constructor({ file, safeStorage, platform = process.platform }) {
    if (!file) throw new Error("A token store needs a file.");
    this.#file = file;
    this.#safeStorage = safeStorage;
    this.#platform = platform;
  }

  keychain() {
    return keychainState(this.#safeStorage, this.#platform);
  }

  async #read() {
    if (this.#loaded) return this.#loaded;
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8"));
      this.#loaded = data && typeof data === "object" && data.vaults ? data : empty();
    } catch (error) {
      if (error.code !== "ENOENT") this.#loaded = empty();
      else this.#loaded = empty();
    }
    return this.#loaded;
  }

  async #write(data) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.#file);
    await chmod(this.#file, 0o600).catch(() => {});
  }

  async hasToken(vaultId) {
    if (this.#session.has(vaultId)) return true;
    const data = await this.#read();
    return Boolean(data.vaults[vaultId]?.cipher);
  }

  async readToken(vaultId) {
    if (this.#session.has(vaultId)) return this.#session.get(vaultId);
    const data = await this.#read();
    const entry = data.vaults[vaultId];
    if (!entry?.cipher) return null;
    const state = this.keychain();
    if (!state.secure) throw tokenError("TOKEN_LOCKED", "Saved sync token cannot be unlocked on this keychain.");
    try {
      return this.#safeStorage.decryptString(Buffer.from(entry.cipher, "base64"));
    } catch {
      throw tokenError("TOKEN_UNREADABLE", "Saved sync token cannot be unlocked. Save it again.");
    }
  }

  // sessionOnly is the documented fallback on `basic_text`; memory only, gone when omarkie quits.
  async saveToken(vaultId, token, { sessionOnly = false } = {}) {
    if (typeof token !== "string" || !token.trim()) throw tokenError("TOKEN_EMPTY", "Paste a token first.");
    if (sessionOnly) {
      this.#session.set(vaultId, token);
      return { stored: "session", keychain: this.keychain() };
    }
    const state = this.keychain();
    if (!state.secure) {
      throw tokenError(
        "TOKEN_INSECURE_KEYCHAIN",
        state.backend === "basic_text"
          ? "Your keychain backend is basic_text, which stores secrets in plain text. Use the token for this session only, or unlock a system keyring and try again."
          : "The OS keychain is not available. Use the token for this session only, or unlock a system keyring and try again.",
      );
    }
    const cipher = this.#safeStorage.encryptString(token).toString("base64");
    const data = await this.#read();
    data.vaults[vaultId] = { cipher, backend: state.backend, updatedAt: new Date().toISOString() };
    await this.#write(data);
    this.#session.delete(vaultId);
    return { stored: "keychain", keychain: state };
  }

  async clearToken(vaultId) {
    this.#session.delete(vaultId);
    const data = await this.#read();
    if (!data.vaults[vaultId]) return { cleared: false };
    delete data.vaults[vaultId];
    await this.#write(data);
    return { cleared: true };
  }

  async forgetSession(vaultId) {
    this.#session.delete(vaultId);
  }
}

export function tokenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
