import { Worker } from "node:worker_threads";

// One index worker per vault. Main sends batches; the worker owns SQLite.
export class GlassIndex {
  constructor({ file }) {
    if (!file) throw new Error("Glass index needs a database path.");
    this.file = file;
    this.requests = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  async open() {
    this.worker = new Worker(new URL("./glass-index-worker.mjs", import.meta.url), { type: "module" });
    this.worker.on("message", message => {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", code => { if (!this.closed) this.fail(new Error(`Glass index worker exited (${code}).`)); });
    this.info = await this.request("open", { dbPath: this.file });
    return this;
  }

  request(op, payload = {}) {
    if (!this.worker) throw new Error("Glass index is not open.");
    if (this.closed) return Promise.reject(new Error("Glass index is closed."));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...payload });
    });
  }

  fail(error) {
    for (const { reject } of this.requests.values()) reject(error);
    this.requests.clear();
  }

  async close() {
    if (this.closed) return;
    try { await this.request("close"); } catch {}
    this.closed = true;
    await this.worker?.terminate().catch(() => {});
    this.fail(new Error("Glass index is closed."));
  }
}
