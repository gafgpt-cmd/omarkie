import { isMap, parseDocument } from "yaml";

export function frontmatter(text) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "", eol = text.includes("\r\n") ? "\r\n" : "\n";
  const open = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (!open) return { bom, eol, start: bom.length, end: bom.length, yaml: "", close: "---", body: text.slice(bom.length), document: parseDocument("") };
  const ending = /^(---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  ending.lastIndex = open[0].length;
  const match = ending.exec(text);
  if (!match) throw new Error("前置元数据未闭合。");
  const yaml = text.slice(open[0].length, match.index), document = parseDocument(yaml, { keepSourceTokens: true, uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map(error => error.message).join("\n"));
  if (document.contents && !isMap(document.contents)) throw new Error("前置元数据必须是 YAML 映射。");
  return { bom, eol, start: open[0].length, end: match.index, yaml, close: match[1], body: text.slice(match.index + match[0].length), document };
}

export function properties(text) {
  return frontmatter(text).document.toJS({ maxAliasCount: 50 }) || {};
}

export function setProperties(text, updates) {
  const fm = frontmatter(text), edits = [], added = [];
  for (const [key, value] of Object.entries(updates)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("属性名无效。");
    const pair = fm.document.contents?.items.find(pair => String(pair.key?.value) === key);
    if (pair && JSON.stringify(fm.document.get(key)?.toJSON?.() ?? fm.document.get(key)) === JSON.stringify(value)) continue;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("属性值无效。");
    if (pair?.value?.range) {
      const [from, to] = pair.value.range;
      edits.push({ from: fm.start + from, to: fm.start + to, value: encoded + (/\r?\n$/.test(fm.yaml.slice(from, to)) ? fm.eol : "") });
    } else if (pair) throw new Error("请在源码模式下编辑这个空属性。");
    else added.push(`${JSON.stringify(key)}: ${encoded}`);
  }
  if (!fm.start || fm.start === fm.bom.length) {
    if (!added.length) return text;
    return fm.bom + "---" + fm.eol + added.join(fm.eol) + fm.eol + "---" + fm.eol + text.slice(fm.bom.length);
  }
  if (added.length) {
    if (fm.document.contents?.flow) {
      const at = fm.start + fm.document.contents.range[1] - 1;
      edits.push({ from: at, to: at, value: (fm.document.contents.items.length ? ", " : "") + added.join(", ") });
    } else edits.push({ from: fm.end, to: fm.end, value: (fm.yaml && !fm.yaml.endsWith("\n") ? fm.eol : "") + added.join(fm.eol) + fm.eol });
  }
  for (const edit of edits.sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.value + text.slice(edit.to);
  return text;
}

// OKF v0.2 §11 is deliberately permissive. Optional-family guidance is not conformance.
export function validateOKF(text, name = "note.md", root = false) {
  const issues = [];
  try {
    const fm = frontmatter(text), values = fm.document.toJS({ maxAliasCount: 50 }) || {};
    if (name.split(/[\\/]/).at(-1) === "index.md") {
      if (Object.keys(values).some(key => key !== "okf_version") || Object.keys(values).length && !root) issues.push("index-frontmatter");
    } else if (name.split(/[\\/]/).at(-1) === "log.md") {
      if (fm.start > fm.bom.length) issues.push("log-frontmatter");
      if ([...fm.body.matchAll(/^##\s+(.+)$/gm)].some(match => !/^\d{4}-\d{2}-\d{2}$/.test(match[1]) || Number.isNaN(Date.parse(match[1])) || new Date(match[1]).toISOString().slice(0, 10) !== match[1])) issues.push("log-date");
    } else {
      if (fm.start === fm.bom.length) issues.push("missing-frontmatter");
      if (typeof values.type !== "string" || !values.type.trim()) issues.push("missing-type");
      if (fm.close !== "---") issues.push("okf-delimiter");
    }
  } catch (error) { issues.push("yaml: " + error.message); }
  return issues;
}

export function makeReady(text, name) {
  const fm = frontmatter(text), values = fm.document.toJS({ maxAliasCount: 50 }) || {};
  if (fm.close === "...") text = text.slice(0, fm.end) + "---" + text.slice(fm.end + 3);
  const updates = {};
  if (typeof values.type !== "string" || !values.type.trim()) updates.type = "Reference";
  if (values.title === undefined) updates.title = name.split(/[\\/]/).at(-1).replace(/\.(md|markdown|mdown)$/i, "");
  if (values.tags === undefined) updates.tags = [];
  return setProperties(text, updates);
}
