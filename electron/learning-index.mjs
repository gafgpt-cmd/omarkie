import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest } from "./store.mjs";
import { readingScope, studySearchSnapshot } from "./reading-store.mjs";
import { learningSearchTerms } from "../shared/learning-search.mjs";

const schema = `CREATE TABLE IF NOT EXISTS revision (value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS scraps USING fts5(document UNINDEXED, line UNINDEXED, kind UNINDEXED, body, context, tokenize='unicode61 remove_diacritics 2');`;
const privateMode = info => process.platform === "win32" || (info.mode & 0o077) === 0;
const requests = new Map();

export async function searchLearning(store, id, query) {
  const terms = learningSearchTerms(query);
  if (!terms.length) return [];
  const { root, current } = await readingScope(store, id);
  const dir = path.join(store.dataDir, "learning-index");
  const file = path.join(dir, `${digest(root)}.sqlite`);
  async function run() {
    await mkdir(dir, { mode: 0o700, recursive: true });
    const metadata = await lstat(dir);
    if (!metadata.isDirectory() || !privateMode(metadata)) throw new Error("Unsafe learning search index path.");
    const info = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (info && (!info.isFile() || info.nlink !== 1 || !privateMode(info))) throw new Error("Unsafe learning search index path.");
    if (!info) await open(file, "wx", 0o600).then(handle => handle.close(), error => { if (error.code !== "EEXIST") throw error; });
    const db = new DatabaseSync(file, { timeout: 2_000 });
    try {
      db.exec(schema);
      const previous = db.prepare("SELECT value FROM revision LIMIT 1").get()?.value;
      const snapshot = await studySearchSnapshot(root, previous);
      if (!current()) return [];
      if (snapshot.entries) {
        db.exec("BEGIN IMMEDIATE; DELETE FROM scraps; DELETE FROM revision;");
        const insert = db.prepare("INSERT INTO scraps(document,line,kind,body,context) VALUES(?,?,?,?,?)");
        for (const item of snapshot.entries) {
          insert.run(item.document, item.anchor?.line ?? null, item.kind, item.body,
            [item.question, item.anchor?.quote].filter(Boolean).join("\n"));
        }
        db.prepare("INSERT INTO revision(value) VALUES(?)").run(snapshot.revision);
        db.exec("COMMIT");
      }
      const match = terms.map(term => `"${term}"*`).join(" ");
      return db.prepare(`SELECT document,line,kind, snippet(scraps,-1,'','',' … ',22) AS text
        FROM scraps WHERE scraps MATCH ? ORDER BY rank, document, rowid LIMIT 60`).all(match);
    } finally { db.close(); }
  }
  const operation = (requests.get(file) ?? Promise.resolve()).then(async () => {
    try { return await run(); }
    catch (error) {
      if (error.code !== "ERR_SQLITE_ERROR" || ![11, 26].includes(error.errcode & 0xff)) throw error;
      await unlink(file);
      return run();
    }
  });
  const settled = operation.catch(() => {});
  requests.set(file, settled);
  try { return await operation; }
  finally { if (requests.get(file) === settled) requests.delete(file); }
}
