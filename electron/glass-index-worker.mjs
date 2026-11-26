// Glass index worker: node:sqlite lives off the main thread so scans never stall the UI.
import { parentPort } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const schemaVersion = 2;
let db = null;

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  hash TEXT,
  note_id TEXT
);
CREATE INDEX IF NOT EXISTS files_note ON files(note_id);
CREATE INDEX IF NOT EXISTS files_kind ON files(kind);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT,
  fingerprint TEXT,
  updated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notes_path ON notes(path);
CREATE TABLE IF NOT EXISTS magnets (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  kind TEXT,
  text TEXT,
  fields TEXT
);
CREATE INDEX IF NOT EXISTS magnets_note ON magnets(note_id);
CREATE TABLE IF NOT EXISTS search_docs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  note_id TEXT,
  title TEXT,
  body TEXT,
  UNIQUE(kind, item_id)
);
CREATE INDEX IF NOT EXISTS search_docs_kind ON search_docs(kind);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body, tokenize = 'unicode61 remove_diacritics 2'
);
`;

function open(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(dbPath);
  const version = db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
  if (version !== schemaVersion) {
    for (const table of ["search_fts", "search_docs", "magnets", "notes", "files"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
  } else db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE INDEX IF NOT EXISTS files_note ON files(note_id); CREATE INDEX IF NOT EXISTS files_kind ON files(kind); CREATE INDEX IF NOT EXISTS notes_path ON notes(path); CREATE INDEX IF NOT EXISTS magnets_note ON magnets(note_id); CREATE INDEX IF NOT EXISTS search_docs_kind ON search_docs(kind);");
  return { dbPath, files: db.prepare("SELECT count(*) AS count FROM files").get().count, notes: db.prepare("SELECT count(*) AS count FROM notes").get().count };
}

function transaction(run) {
  db.exec("BEGIN");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function indexFiles(files) {
  if (!files?.length) return 0;
  return transaction(() => {
    const upsert = db.prepare(`INSERT INTO files(path, kind, size, mtime, hash, note_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, size = excluded.size, mtime = excluded.mtime,
      hash = coalesce(excluded.hash, files.hash), note_id = coalesce(excluded.note_id, files.note_id)`);
    const findDoc = db.prepare("SELECT id FROM search_docs WHERE kind = 'note' AND item_id = ?");
    const insertDoc = db.prepare("INSERT INTO search_docs(kind, item_id, note_id, title, body) VALUES ('note', ?, ?, ?, ?)");
    const updateDoc = db.prepare("UPDATE search_docs SET note_id = ?, title = ?, body = ? WHERE id = ?");
    const insertSearch = db.prepare("INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)");
    const dropSearch = db.prepare("DELETE FROM search_fts WHERE rowid = ?");
    for (const file of files) {
      upsert.run(file.path, file.kind ?? "other", file.size ?? 0, file.mtime ?? 0, file.hash ?? null, file.noteId ?? null);
      if (file.text === undefined) continue;
      const title = file.title ?? "", body = file.text.slice(0, 512 * 1024), existing = findDoc.get(file.path);
      if (existing) {
        dropSearch.run(existing.id);
        updateDoc.run(file.noteId ?? null, title, body, existing.id);
        insertSearch.run(existing.id, title, body);
      } else {
        const info = insertDoc.run(file.path, file.noteId ?? null, title, body);
        insertSearch.run(Number(info.lastInsertRowid), title, body);
      }
    }
    return files.length;
  });
}

function removeFiles(paths) {
  if (!paths?.length) return 0;
  return transaction(() => {
    const remove = db.prepare("DELETE FROM files WHERE path = ?");
    const findDoc = db.prepare("SELECT id FROM search_docs WHERE kind = 'note' AND item_id = ?");
    const removeDoc = db.prepare("DELETE FROM search_docs WHERE id = ?");
    const dropSearch = db.prepare("DELETE FROM search_fts WHERE rowid = ?");
    for (const file of paths) {
      remove.run(file);
      const doc = findDoc.get(file);
      if (!doc) continue;
      dropSearch.run(doc.id);
      removeDoc.run(doc.id);
    }
    return paths.length;
  });
}

function putNotes(notes) {
  return transaction(() => {
    db.exec("DELETE FROM notes");
    const insert = db.prepare("INSERT INTO notes(id, path, title, fingerprint, updated) VALUES (?, ?, ?, ?, ?)");
    for (const note of notes ?? []) insert.run(note.id, note.path, note.title ?? "", JSON.stringify(note.fingerprint ?? null), Date.now());
    const attach = db.prepare("UPDATE files SET note_id = ? WHERE path = ?");
    for (const note of notes ?? []) attach.run(note.id, note.path);
    return notes?.length ?? 0;
  });
}

function putMagnets(magnets) {
  return transaction(() => {
    db.exec("DELETE FROM magnets");
    const stale = db.prepare("SELECT id FROM search_docs WHERE kind = 'magnet'").all();
    const dropSearch = db.prepare("DELETE FROM search_fts WHERE rowid = ?");
    const dropDoc = db.prepare("DELETE FROM search_docs WHERE id = ?");
    for (const doc of stale) { dropSearch.run(doc.id); dropDoc.run(doc.id); }
    const insert = db.prepare("INSERT OR REPLACE INTO magnets(id, note_id, kind, text, fields) VALUES (?, ?, ?, ?, ?)");
    const insertDoc = db.prepare("INSERT INTO search_docs(kind, item_id, note_id, title, body) VALUES ('magnet', ?, ?, ?, ?)");
    const insertSearch = db.prepare("INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)");
    for (const magnet of magnets ?? []) {
      insert.run(magnet.id, magnet.noteId, magnet.kind ?? "", magnet.text ?? "", JSON.stringify(magnet.fields ?? {}));
      const info = insertDoc.run(magnet.id, magnet.noteId, magnet.kind ?? "", magnet.text ?? "");
      insertSearch.run(Number(info.lastInsertRowid), magnet.kind ?? "", magnet.text ?? "");
    }
    return magnets?.length ?? 0;
  });
}

function map() {
  const kinds = db.prepare("SELECT kind, count(*) AS count FROM files GROUP BY kind").all();
  const biggest = db.prepare(`SELECT CASE WHEN instr(path, '/') = 0 THEN '.' ELSE substr(path, 1, instr(path, '/') - 1) END AS folder,
    count(*) AS count FROM files GROUP BY folder ORDER BY count DESC LIMIT 8`).all();
  return {
    files: db.prepare("SELECT count(*) AS count FROM files").get().count,
    kinds: Object.fromEntries(kinds.map(row => [row.kind, row.count])),
    topLevel: biggest.map(row => ({ folder: row.folder, files: row.count })),
    notes: db.prepare("SELECT count(*) AS count FROM notes").get().count,
    magnets: db.prepare("SELECT count(*) AS count FROM magnets").get().count,
  };
}

function searchQuery(value) {
  return String(value ?? "").split(/\s+/).filter(Boolean).map(term => `"${term.replaceAll('"', '""')}"*`).join(" ");
}

function find(query, limit = 20) {
  const match = searchQuery(query);
  if (!match) return [];
  return db.prepare(`SELECT docs.kind, docs.item_id AS id, docs.note_id, docs.title,
    coalesce(notes.path, files.path) AS path, files.kind AS file_kind,
    snippet(search_fts, 1, '[', ']', '…', 18) AS snippet
    FROM search_fts
    JOIN search_docs docs ON docs.id = search_fts.rowid
    LEFT JOIN files ON files.path = docs.item_id
    LEFT JOIN notes ON notes.id = docs.note_id
    WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, Math.max(1, Math.min(200, limit)));
}

function snapshot() {
  return db.prepare("SELECT path, kind, size, mtime, hash, note_id FROM files").all();
}

function file(pathName) {
  return db.prepare("SELECT * FROM files WHERE path = ?").get(pathName) ?? null;
}

// A card link such as [[Note]] resolves by basename once the vault is indexed; shortest path wins.
function locate({ target }) {
  const clean = String(target ?? "").replace(/\.(?:md|markdown|mdown)$/i, "").replace(/^\/+/, "").slice(0, 2048);
  if (!clean) return [];
  const escaped = clean.replace(/[\\%_]/g, value => `\\${value}`);
  return db.prepare(`SELECT path FROM files WHERE kind = 'note' AND (path = ? OR path LIKE ? ESCAPE '\\')
    ORDER BY length(path), path LIMIT 8`).all(`${clean}.md`, `%/${escaped}.md`).map(row => row.path);
}

function close() {
  db?.close();
  db = null;
}

const operations = {
  open: ({ dbPath }) => open(dbPath),
  files: ({ files }) => indexFiles(files),
  remove: ({ paths }) => removeFiles(paths),
  notes: ({ notes }) => putNotes(notes),
  magnets: ({ magnets }) => putMagnets(magnets),
  map: () => map(),
  find: ({ query, limit }) => find(query, limit),
  locate: ({ target }) => locate({ target }),
  file: ({ path: pathName }) => file(pathName),
  snapshot: () => snapshot(),
  close: () => { close(); return true; },
  ping: () => ({ ok: true, files: db ? db.prepare("SELECT count(*) AS count FROM files").get().count : 0 }),
};

parentPort.on("message", message => {
  const reply = (value, error) => parentPort.postMessage({ id: message.id, ...(error ? { error: error.message } : { value }) });
  const operation = operations[message.op];
  if (!operation) return reply(null, new Error(`Unknown index operation: ${message.op}`));
  try { reply(operation(message)); }
  catch (error) { reply(null, error); }
});
