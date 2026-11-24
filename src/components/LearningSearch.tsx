import { useState, useRef } from "react";
import { Dialog } from "./Dialog";
import { learningSearchTerms } from "../../shared/learning-search.mjs";
import { host } from "../host";
import { t } from "../i18n";
import type { StudySearchMatch } from "../types";

export default function LearningSearch({ id, close, open }: {
  id: string; close(): void; open(match: StudySearchMatch): Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StudySearchMatch[]>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const latest = useRef(0);
  async function search(phrase: string) {
    const serial = ++latest.current;
    const terms = learningSearchTerms(phrase);
    setError(""); setBusy(!!terms.length); setResults(undefined);
    if (!terms.length) return;
    try {
      const matches = host.learningSearch ? await host.learningSearch(id, phrase) : await scanJournal(id, terms);
      if (serial === latest.current) setResults(matches);
    } catch { if (serial === latest.current) setError(t("Could not search scraps.")); }
    finally { if (serial === latest.current) setBusy(false); }
  }
  return <Dialog title={t("Search scraps")} close={close}>
    <form className="study-search-form" onSubmit={event => { event.preventDefault(); void search(query); }}>
      <input type="search" aria-label={t("Search scraps")} value={query} maxLength={160} onChange={event => setQuery(event.target.value)} />
      <button type="submit" className="primary-button" disabled={busy || !query.trim()}>{t("Search")}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {results && (results.length ? <ul className="study-search-results">{results.map((match, index) =>
      <li key={index}><button type="button" onClick={async () => { if (await open(match)) close(); else setError(t("This note is no longer available.")); }}>
        <strong>{match.document}{match.line === null ? "" : `:${match.line}`}</strong><span>{match.text}</span>
      </button></li>)}</ul> : <p role="status">{t("No scraps found.")}</p>)}
  </Dialog>;
}

async function scanJournal(id: string, terms: string[]) {
  const entries = await host.readingStore!(id, { action: "list", scope: "vault", types: ["note", "scrap"], studyNotes: true });
  const results: StudySearchMatch[] = [];
  for (const item of entries) if ((item.type === "note" || item.type === "scrap" && !item.image) &&
    terms.every(term => `${item.body}\n${item.anchor?.quote ?? ""}`.normalize("NFC").toLowerCase().includes(term))) {
    results.push({ document: item.document, line: item.anchor?.line ?? null, kind: item.type === "scrap" ? item.kind : "note", text: item.body.slice(0, 320) });
    if (results.length === 60) break;
  }
  return results;
}
