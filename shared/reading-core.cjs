// Also evaluated by the native host in an isolated JavaScriptCore context.
module.exports = function readingCore(digest, translate = message => message) {
  const kinds = new Set(["note", "card", "answer", "sheet", "scrap", "mark", "ink", "confidence"]);
  const scrapKinds = new Set(["note", "doubt", "answer", "clip", "card", "exam", "evidence", "gloss", "proposal"]);
  const colours = new Set(["amber", "blue", "rose", "green"]);
  const legacyNotePrefix = "legacy-note:";
  const maxImageBytes = 20 * 1024 * 1024;
  const imageHash = hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
  function imageType(prefix) {
    if (prefix.startsWith("89504e470d0a1a0a")) return "png";
    if (prefix.startsWith("ffd8ff")) return "jpeg";
    if (/^47494638(?:37|39)61/.test(prefix)) return "gif";
    if (/^52494646.{8}57454250/.test(prefix)) return "webp";
    throw invalid();
  }
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
  function boolean(value) {
    if (typeof value !== "boolean") throw invalid();
    return value;
  }
  function colour(value) {
    if (!colours.has(value)) throw invalid();
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
      case "sheet": return { ...base, name: text(item.name, 80), colour: colour(item.colour), order: number(item.order, 0, 1_000_000), visible: boolean(item.visible) };
      case "scrap": {
        if (!scrapKinds.has(item.kind) || item.stackOf === item.id) throw invalid();
        if (item.image && (item.kind !== "clip" || !imageHash(item.image.hash) || !["left", "right"].includes(item.image.side))) throw invalid();
        const image = item.image && { hash: item.image.hash, side: item.image.side, width: number(item.image.width, 96, 1600) };
        const anchor = item.anchor === null ? null : target(item.anchor);
        const before = item.kind === "proposal" ? text(item.before, 24_000) : undefined;
        if (before !== undefined && (item.sheet !== "proposals" || item.stackOf !== null || anchor?.block !== normalize(before))) throw invalid();
        const question = ["answer", "proposal", "exam", "gloss"].includes(item.kind) && item.question !== undefined ? text(item.question, 1_000) : undefined;
        return { ...base, sheet: identifier(item.sheet), kind: item.kind, anchor,
          body: text(item.body), stackOf: item.stackOf === null ? null : identifier(item.stackOf), folded: boolean(item.folded),
          deleted: boolean(item.deleted ?? false), ...(image ? { image } : {}), ...(before === undefined ? {} : { before }), ...(question === undefined ? {} : { question }) };
      }
      case "mark": {
        const start = number(item.start, 0, 262_143), end = number(item.end, start + 1, 262_144);
        return { ...base, sheet: identifier(item.sheet), anchor: target(item.anchor), start, end, colour: colour(item.colour), deleted: boolean(item.deleted ?? false) };
      }
      case "ink": return { ...base, sheet: identifier(item.sheet), anchor: target(item.anchor), from: text(item.from), to: item.to === "" ? "" : text(item.to), deleted: boolean(item.deleted ?? false) };
      case "confidence": return { ...base, anchor: target(item.anchor), level: number(item.level, 0, 3) };
    }
  }

  function imageItem(request, hash) {
    return itemAt({ id: request.id, type: "scrap", kind: "clip", sheet: "images", anchor: request.anchor,
      body: text(request.name, 200), stackOf: null, folded: false, image: { hash, side: request.side, width: request.width } });
  }

  function validate(request) {
    if (!request || typeof request !== "object") throw invalid();
    if (request.action === "readImage") {
      if (!imageHash(request.hash)) throw invalid();
      return { imageHash: request.hash };
    }
    if (request.action === "putImage") {
      const bytes = request.bytes;
      if (bytes === undefined && typeof request.address === "string") return { imageBytes: null };
      if (typeof bytes !== "string" || bytes.length < 16 || bytes.length > Math.ceil(maxImageBytes / 3) * 4) throw invalid();
      return { imageBytes: bytes };
    }
    if (request.action === "put") {
      const item = itemAt(request.item);
      if (item.type === "answer" && !validPath(request.owner)) throw invalid();
      return { item, owner: request.owner };
    }
    if (request.action === "resolve" || request.action === "study") {
      if (!Array.isArray(request.blocks) || request.blocks.length > 250_000) throw invalid();
      let size = 0;
      return { study: request.action === "study", blocks: request.blocks.map(input => {
        const block = blockAt(input);
        size += block.block.length + block.headings.reduce((total, heading) => total + heading.length, 0);
        if (size > 40_000_000) throw invalid();
        return block;
      }) };
    }
    if (request.action === "list") {
      if (request.scope !== undefined && request.scope !== "document" && request.scope !== "vault") throw invalid();
      if (request.types !== undefined && (!Array.isArray(request.types) || request.types.length > kinds.size || request.types.some(kind => !kinds.has(kind)))) throw invalid();
      return { scope: request.scope, types: request.types, studyNotes: request.studyNotes === true };
    }
    throw invalid();
  }

  function indexEntry(entries, entry) {
    if (entry.type === "sheet") {
      (entries.sheets ??= new Map()).set(entry.id, entry);
      return;
    }
    let items = entries.get(entry.document);
    if (!items) entries.set(entry.document, items = new Map());
    items.set(`${entry.type}:${entry.id}`, entry);
  }

  const validPath = value => typeof value === "string" && !value.includes("\0") && value.split("/").every(part => part && part !== "." && part !== "..");

  function checkMove(from, to) {
    if (!validPath(from) || !validPath(to) || from === to) throw invalid();
  }

  const under = (file, prefix) => file === prefix || file.startsWith(prefix + "/");
  const tracked = (entries, prefix) => [...entries.keys()].filter(file => under(file, prefix)).map(file => file.slice(prefix.length + 1));
  function checkPending(entries, document, subtree = false) {
    const intent = entries.pending;
    if (intent && [intent.from, intent.to].some(path => under(document, path) || subtree && under(path, document))) {
      throw Object.assign(new Error(translate("Resolve the pending reading move before editing reading history.")), { code: "LEARNING_ERROR" });
    }
  }

  function putDocument(entries, document, item, owner) {
    if (!validPath(document)) throw invalid();
    if (item.type === "answer") {
      if (!entries.get(owner)?.has(`card:${item.cardId}`)) throw invalid();
      checkPending(entries, owner);
      return owner;
    }
    if (item.type === "sheet") return document;
    checkPending(entries, document);
    if (item.type !== "card") return document;
    const items = entries.get(document);
    if (items && !items.has(`card:${item.id}`) && [...items.values()].filter(entry => entry.type === "card").length >= 10) throw invalid();
    return document;
  }

  function readJournal(committed) {
    const entries = new Map();
    for (const row of committed.split("\n")) {
      if (!row) continue;
      applyRow(entries, row);
    }
    return entries;
  }

  function applyRow(entries, row) {
      try {
        const { v, entry, move, intent, cancel, trash, restore, purgeTrash } = JSON.parse(row);
        if (v !== 1) throw invalid();
        if (purgeTrash !== undefined) {
          const id = identifier(purgeTrash);
          entries.trash?.delete(id);
          return;
        }
        if (trash || restore) {
          const { path, id } = trash ?? restore;
          if (!validPath(path)) throw invalid();
          checkPending(entries, path, true);
          identifier(id);
          entries.trash ??= new Map();
          if (trash) {
            if (entries.trash.has(id)) throw invalid();
            const detached = [...entries].filter(([file]) => under(file, path));
            entries.trash.set(id, detached);
            for (const [file] of detached) entries.delete(file);
          } else {
            const detached = entries.trash.get(id);
            if (!detached || detached.some(([file]) => !under(file, path))) throw invalid();
            for (const [file] of entries) if (under(file, path)) entries.delete(file);
            for (const [file, items] of detached) entries.set(file, items);
            entries.trash.delete(id);
          }
          return;
        }
        if (intent) {
          checkMove(intent.from, intent.to);
          if (typeof intent.fingerprint !== "string" || !/^\d+:[a-f0-9]{64}$/.test(intent.fingerprint)) throw invalid();
          for (const paths of [intent.files, intent.collisions]) {
            if (paths !== undefined && (!Array.isArray(paths) || paths.some(file => file !== "" && !validPath(file)))) throw invalid();
          }
          if (entries.pending) throw invalid();
          entries.pending = intent;
          return;
        }
        if (cancel === true) {
          if (!entries.pending) throw invalid();
          delete entries.pending;
          return;
        }
        if (move) {
          const { from, to } = move;
          checkMove(from, to);
          if (entries.pending?.from !== from || entries.pending?.to !== to) throw invalid();
          const { files = [""], collisions = [] } = entries.pending;
          const moved = files.map(suffix => suffix ? `${from}/${suffix}` : from)
            .filter(file => entries.has(file)).map(file => [file, entries.get(file)]);
          delete entries.pending;
          for (const suffix of [...files, ...collisions]) entries.delete(suffix ? `${to}/${suffix}` : to);
          for (const [file] of moved) entries.delete(file);
          for (const [file, items] of moved) {
            const document = to + file.slice(from.length);
            for (const item of items.values()) indexEntry(entries, { ...item, document });
          }
          return;
        }
        if (!validPath(entry.document) || typeof entry.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.at) || !Number.isFinite(Date.parse(entry.at)) || new Date(entry.at).toISOString() !== entry.at) throw invalid();
        if (entry.type !== "sheet") checkPending(entries, entry.document);
        indexEntry(entries, { ...itemAt(entry), document: entry.document, at: entry.at });
      } catch { entries.badRows = (entries.badRows ?? 0) + 1; }
  }

  const allEntries = entries => Array.from(entries.values()).flatMap(items => [...items.values()]);
  function studyEntries(entries, document, blocks) {
    const items = entries.get(document);
    const study = [...(entries.sheets?.values() ?? [])];
    const anchored = [];
    for (const item of items?.values() ?? []) {
      let entry = item;
      if (item.type === "note") {
        const id = legacyNotePrefix + digest(item.id);
        if (items.has(`scrap:${id}`)) continue;
        entry = { ...item, id, type: "scrap", sheet: "notes", kind: "note", stackOf: null, folded: true };
      } else if (!["scrap", "mark", "ink", "confidence"].includes(item.type) || item.deleted) continue;
      study.push(entry);
      if (entry.anchor) anchored.push(entry);
    }
    return { entries: study, locations: resolveReadingAnchors(anchored, blocks) };
  }

  function query(entries, document, { scope, types, blocks, study, studyNotes }) {
    if (study) return studyEntries(entries, document, blocks);
    const items = scope === "vault" ? allEntries(entries) : [...(entries.get(document)?.values() ?? [])];
    if (blocks) return resolveReadingAnchors(items.filter(entry => entry.type === "note"), blocks);
    if (types?.includes("sheet")) items.push(...(entries.sheets?.values() ?? []));
    if (!studyNotes) return types ? items.filter(entry => types.includes(entry.type)) : items;
    const result = [];
    for (const item of items) {
      if (item.type === "note" && entries.get(item.document).has(`scrap:${legacyNotePrefix}${digest(item.id)}`)) continue;
      if (item.type === "scrap" && item.deleted) continue;
      if (types?.includes("note") && item.type === "scrap" && item.kind === "note" && item.anchor) {
        result.push({ ...item, type: "note" });
      } else if (!types || types.includes(item.type)) result.push(item);
    }
    return result;
  }

  function readingMarkdown(items) {
    const quote = text => text.replaceAll("\r", "").split("\n").map(line => `> ${line}`).join("\n");
    return items.filter(item => !item.image && item.kind !== "proposal").map(item => {
      const source = quote([item.document, ...(item.anchor?.headings || [])].join(" › "));
      if (item.type === "note" || item.type === "scrap") {
        return `${source}${item.anchor ? `\n${quote(item.anchor.quote)}` : ""}\n\n${item.body}`;
      }
      return `${source}\n\n${item.front}\n\n${item.back}`;
    }).join("\n\n---\n\n") + "\n";
  }

  return { validate, putDocument, checkMove, checkPending, tracked, validPath, readJournal, applyRow, pending: entries => entries.pending ?? null, badRows: entries => entries.badRows ?? 0, hasTrash: (entries, id) => entries.trash?.has(id) ?? false, query, readingMarkdown, readingAnchor, resolveReadingAnchors, imageType, imageItem, maxImageBytes };
};
