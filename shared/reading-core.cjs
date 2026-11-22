// Also evaluated by the native host in an isolated JavaScriptCore context.
module.exports = function readingCore(digest) {
  const kinds = new Set(["note", "card", "answer"]);
  const invalid = () => new Error("阅读图层数据无效。");
  const normalize = text => text.normalize("NFC").replace(/\s+/gu, " ").trim();
  const identity = (block, section) => digest(JSON.stringify([block, section]));
  const sectionKey = headings => JSON.stringify(headings.map(normalize));

  function readingAnchor({ block, headings, line, quote }) {
    block = normalize(block);
    headings = headings.map(normalize);
    return { block, headings, line, quote, hash: identity(block, JSON.stringify(headings)) };
  }

  function grams(text) {
    const counts = new Map();
    for (let i = 0, n = Math.max(text.length - 2, 1); i < n; i++) {
      const gram = text.slice(i, i + 3);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  }

  function similarity(text, candidate, counts) {
    const length = Math.max(text.length - 2, 1), other = Math.max(candidate.length - 2, 1);
    if (2 * Math.min(length, other) < 0.8 * (length + other)) return 0;
    let shared = 0;
    for (const [gram, count] of grams(candidate)) shared += Math.min(count, counts.get(gram) || 0);
    return 2 * shared / (length + other);
  }

  function resolveReadingAnchors(notes, blocks) {
    if (!notes.length) return [];
    const hashes = new Map(), sections = new Map(), byText = new Map();
    for (const note of notes) sections.set(sectionKey(note.anchor.headings), []);
    for (const { block, headings, line } of blocks) {
      const text = normalize(block);
      if (!text) continue;
      const section = sectionKey(headings), candidates = sections.get(section);
      if (candidates) {
        const hash = identity(text, section);
        hashes.set(hash, hashes.has(hash) ? null : line);
        candidates.push({ text, line });
      }
      // An unchanged block can survive a renamed heading, but never guess between copies.
      const found = byText.get(text);
      byText.set(text, found === undefined ? line : null);
    }
    return notes.map(({ id, anchor }) => {
      let line = null;
      if (hashes.has(anchor.hash)) line = hashes.get(anchor.hash);
      else if (byText.has(anchor.block)) line = byText.get(anchor.block);
      else {
        const counts = grams(anchor.block);
        let best = 0;
        for (const candidate of sections.get(sectionKey(anchor.headings))) {
          const score = similarity(anchor.block, candidate.text, counts);
          if (score >= 0.8 && score > best) {
            line = candidate.line; best = score;
          } else if (score === best) line = null;
        }
      }
      return { id, line };
    });
  }

  function text(value, max = 65_536) {
    if (typeof value !== "string" || value.length > max || !value.trim()) throw invalid();
    return value;
  }
  function identifier(value) {
    if (typeof value !== "string" || !/^[\w.:-]{1,200}$/.test(value)) throw invalid();
    return value;
  }
  function number(value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw invalid();
    return value;
  }
  function blockAt(value) {
    if (!value || !Array.isArray(value.headings) || value.headings.length > 6 || value.headings.some(heading => typeof heading !== "string" || heading.length > 262_144)) throw invalid();
    if (typeof value.block !== "string" || value.block.length > 20_000_000) throw invalid();
    return { block: value.block, headings: value.headings, line: number(value.line, 1, 20_000_000) };
  }
  function target(value) {
    const block = blockAt(value);
    if (!block.block.trim() || block.block.length > 262_144) throw invalid();
    return readingAnchor({ ...block, quote: text(value.quote) });
  }
  function itemAt(item) {
    if (!item || !kinds.has(item.type)) throw invalid();
    const base = { id: identifier(item.id), type: item.type };
    switch (item.type) {
      case "note": return { ...base, body: text(item.body), anchor: target(item.anchor) };
      case "card": return { ...base, front: text(item.front), back: text(item.back), ...(item.anchor === undefined ? {} : { anchor: target(item.anchor) }) };
      case "answer": return { ...base, cardId: identifier(item.cardId), rating: number(item.rating, 0, 5) };
    }
  }

  function validate(request) {
    if (!request || typeof request !== "object") throw invalid();
    if (request.action === "put") return { item: itemAt(request.item) };
    if (request.action === "resolve") {
      if (!Array.isArray(request.blocks) || request.blocks.length > 250_000) throw invalid();
      let size = 0;
      return { blocks: request.blocks.map(input => {
        const block = blockAt(input);
        size += block.block.length + block.headings.reduce((total, heading) => total + heading.length, 0);
        if (size > 40_000_000) throw invalid();
        return block;
      }) };
    }
    if (request.action === "list") {
      if (request.scope !== undefined && request.scope !== "document" && request.scope !== "vault") throw invalid();
      if (request.types !== undefined && (!Array.isArray(request.types) || request.types.length > kinds.size || request.types.some(kind => !kinds.has(kind)))) throw invalid();
      return { scope: request.scope, types: request.types };
    }
    throw invalid();
  }

  function indexEntry(entries, entry) {
    let items = entries.get(entry.document);
    if (!items) entries.set(entry.document, items = new Map());
    items.set(`${entry.type}:${entry.id}`, entry);
  }

  function checkPut(entries, document, item) {
    if (item.type !== "card") return;
    const items = entries.get(document);
    if (items && !items.has(`card:${item.id}`) && [...items.values()].filter(entry => entry.type === "card").length >= 10) throw invalid();
  }

  function readJournal(committed) {
    const entries = new Map();
    try {
      for (const row of committed.split("\n")) {
        if (!row) continue;
        const { v, entry, move, intent, cancel } = JSON.parse(row);
        if (v !== 1) throw invalid();
        const validPath = value => typeof value === "string" && !value.includes("\0") && value.split("/").every(part => part && part !== "." && part !== "..");
        if (intent) {
          if (entries.pending || !validPath(intent.from) || !validPath(intent.to) || intent.from === intent.to || !/^\d+:\d+$/.test(intent.identity)) throw invalid();
          entries.pending = intent;
          continue;
        }
        if (cancel === true) {
          if (!entries.pending) throw invalid();
          delete entries.pending;
          continue;
        }
        if (move) {
          const { from, to } = move;
          if (!validPath(from) || !validPath(to) || from === to) throw invalid();
          if (entries.pending && (entries.pending.from !== from || entries.pending.to !== to)) throw invalid();
          delete entries.pending;
          const under = (file, prefix) => file === prefix || file.startsWith(prefix + "/");
          const moved = [...entries].filter(([file]) => under(file, from));
          for (const file of entries.keys()) if (under(file, from) || under(file, to)) entries.delete(file);
          for (const [file, items] of moved) {
            const document = to + file.slice(from.length);
            for (const item of items.values()) indexEntry(entries, { ...item, document });
          }
          continue;
        }
        if (entries.pending || typeof entry.document !== "string" || typeof entry.at !== "string") throw invalid();
        indexEntry(entries, { ...itemAt(entry), document: entry.document, at: entry.at });
      }
    } catch { throw new Error("阅读记录损坏，未更改原文件。"); }
    return entries;
  }

  const allEntries = entries => Array.from(entries.values()).flatMap(items => [...items.values()]);
  function query(entries, document, { scope, types, blocks }) {
    const items = scope === "vault" ? allEntries(entries) : [...(entries.get(document)?.values() ?? [])];
    if (blocks) return resolveReadingAnchors(items.filter(entry => entry.type === "note"), blocks);
    return types ? items.filter(entry => types.includes(entry.type)) : items;
  }

  function readingMarkdown(items) {
    const quote = text => text.replaceAll("\r", "").split("\n").map(line => `> ${line}`).join("\n");
    return items.map(item => {
      const source = quote([item.document, ...(item.anchor?.headings || [])].join(" › "));
      return item.type === "note" ? `${source}\n${quote(item.anchor.quote)}\n\n${item.body}` : `${source}\n\n${item.front}\n\n${item.back}`;
    }).join("\n\n---\n\n") + "\n";
  }

  return { validate, checkPut, readJournal, pending: entries => entries.pending ?? null, allEntries, query, readingMarkdown, readingAnchor, resolveReadingAnchors };
};
