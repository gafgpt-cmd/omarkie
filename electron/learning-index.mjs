import { DatabaseSync } from "node:sqlite";
import { readingScope, studySearchSnapshot } from "./reading-store.mjs";
import { learningSearchTerms } from "../shared/learning-search.mjs";

export async function searchLearning(store, id, query) {
  const terms = learningSearchTerms(query);
  if (!terms.length) return [];
  const { root, current } = await readingScope(store, id);
  const entries = await studySearchSnapshot(root);
  if (!current()) return [];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE scraps USING fts5(document UNINDEXED, line UNINDEXED, kind UNINDEXED, body, context, tokenize='unicode61 remove_diacritics 2');
      BEGIN;`);
    const insert = db.prepare("INSERT INTO scraps(document,line,kind,body,context) VALUES(?,?,?,?,?)");
    for (const item of entries) {
      insert.run(item.document, item.anchor?.line ?? null, item.kind, item.body,
        [item.question, item.anchor?.quote].filter(Boolean).join("\n"));
    }
    db.exec("COMMIT");
    const match = terms.map(term => `"${term}"*`).join(" ");
    return db.prepare(`SELECT document,line,kind, snippet(scraps,-1,'','',' … ',22) AS text
      FROM scraps WHERE scraps MATCH ? ORDER BY rank, document, rowid LIMIT 60`).all(match);
  } finally { db.close(); }
}
