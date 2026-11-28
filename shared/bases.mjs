// Obsidian Bases (`.base`), read-only: a documented subset of views, filters, sorting and property labels evaluated
// over note front matter. Pure: the app supplies note text and stamps. Nothing here writes, so keys and grammar we do
// not support stay in the file byte for byte; they surface as diagnostics instead of silently changing results.
import { parse } from "yaml";
import { frontmatter } from "./frontmatter.mjs";

export const baseLimits = { bytes: 256 * 1024, expression: 4096, depth: 48, filters: 500, views: 64, rows: 1000 };
const topKeys = new Set(["filters", "formulas", "properties", "summaries", "views"]);
const viewTypes = new Set(["table", "cards"]);
const fileFields = new Set(["name", "basename", "path", "folder", "ext", "size", "ctime", "mtime", "tags", "properties"]);
const globals = new Set(["date", "now", "today", "number", "if", "list"]);
const methods = new Set(["contains", "containsAll", "containsAny", "startsWith", "endsWith", "lower", "upper", "trim", "isEmpty", "isTruthy", "toString", "date"]);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
class Unsupported extends Error {}

// ---- expressions -------------------------------------------------------------------------------------------------
const token = /\s+|(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([\p{L}_][\p{L}\p{N}_]*)|(==|!=|>=|<=|&&|\|\||[<>!+\-*/%().,[\]])/uy;
function tokenize(source) {
  const tokens = [];
  token.lastIndex = 0;
  while (token.lastIndex < source.length) {
    const at = token.lastIndex, match = token.exec(source);
    if (!match) throw new Unsupported(`unexpected "${source[at]}" at ${at + 1}`);
    if (match[1]) tokens.push({ kind: "number", value: Number(match[1]) });
    else if (match[2]) tokens.push({ kind: "string", value: match[2].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (match[3]) tokens.push({ kind: "name", value: match[3] });
    else if (match[4]) tokens.push({ kind: "op", value: match[4] });
  }
  return tokens;
}
const precedence = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
export function parseExpression(source) {
  if (typeof source !== "string") throw new Unsupported("not text");
  if (source.length > baseLimits.expression) throw new Unsupported("too long");
  const tokens = tokenize(source);
  let at = 0, depth = 0;
  const peek = value => tokens[at]?.kind === "op" && tokens[at].value === value;
  const expect = value => { if (!peek(value)) throw new Unsupported(`expected "${value}"`); at += 1; };
  const nest = run => { if (++depth > baseLimits.depth) throw new Unsupported("nested too deep"); try { return run(); } finally { depth -= 1; } };
  const list = close => { const items = []; while (!peek(close)) { items.push(binary(0)); if (!peek(close)) expect(","); } expect(close); return items; };
  function primary() {
    const next = tokens[at++];
    if (!next) throw new Unsupported("incomplete expression");
    if (next.kind === "number" || next.kind === "string") return { type: "literal", value: next.value };
    if (next.kind === "name") return ["true", "false", "null"].includes(next.value) ? { type: "literal", value: JSON.parse(next.value) } : { type: "name", name: next.value };
    if (next.value === "(") { const inner = nest(() => binary(0)); expect(")"); return inner; }
    if (next.value === "[") return { type: "list", items: nest(() => list("]")) };
    if (next.value === "!" || next.value === "-") return { type: "unary", op: next.value, argument: nest(() => postfix(primary())) };
    throw new Unsupported(`unexpected "${next.value}"`);
  }
  function postfix(node) {
    for (;;) {
      if (peek(".")) { at += 1; const name = tokens[at++]; if (name?.kind !== "name") throw new Unsupported("expected a name after \".\""); node = { type: "member", object: node, name: name.value }; }
      else if (peek("[")) { at += 1; node = { type: "member", object: node, key: nest(() => binary(0)) }; expect("]"); }
      else if (peek("(")) { at += 1; node = { type: "call", callee: node, args: nest(() => list(")")) }; }
      else return node;
    }
  }
  function binary(minimum) {
    let left = postfix(primary());
    for (;;) {
      const next = tokens[at], level = next?.kind === "op" ? precedence[next.value] : undefined;
      if (!level || level <= minimum) return left;
      at += 1;
      left = { type: "binary", op: next.value, left, right: nest(() => binary(level)) };
    }
  }
  const tree = binary(0);
  if (at < tokens.length) throw new Unsupported(`unexpected "${tokens[at].value}"`);
  return tree;
}

// ---- values ------------------------------------------------------------------------------------------------------
const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
function toDate(value) {
  if (value instanceof Date) return value;
  const match = typeof value === "string" && isoDate.exec(value.trim());
  if (!match) return null;
  const date = new Date(+match[1], +match[2] - 1, +match[3], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0));
  return Number.isNaN(date.getTime()) ? null : date;
}
const toNumber = value => typeof value === "number" ? value : typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : null;
const units = { y: "y", year: "y", years: "y", M: "M", month: "M", months: "M", w: "w", week: "w", weeks: "w", d: "d", day: "d", days: "d", h: "h", hour: "h", hours: "h", m: "m", minute: "m", minutes: "m", s: "s", second: "s", seconds: "s" };
function shift(date, duration, sign) {
  const match = /^\s*(\d+)\s*([A-Za-z]+)\s*$/.exec(duration), unit = match && units[match[2]];
  if (!unit) return null;
  const amount = sign * Number(match[1]), next = new Date(date);
  if (unit === "y") next.setFullYear(next.getFullYear() + amount);
  else if (unit === "M") next.setMonth(next.getMonth() + amount);
  else next.setTime(next.getTime() + amount * { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000 }[unit]);
  return next;
}
const empty = value => value === null || value === undefined || value === "" || Array.isArray(value) && !value.length || plain(value) && !Object.keys(value).length;
const truthy = value => !empty(value) && value !== false && value !== 0;
const text = value => value === null || value === undefined ? "" : value instanceof Date ? formatDate(value) : Array.isArray(value) ? value.map(text).join(", ") : plain(value) ? JSON.stringify(value) : String(value);
function formatDate(date) {
  const pad = number => String(number).padStart(2, "0"), day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getHours() || date.getMinutes() || date.getSeconds() ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}
// Typed comparison: dates against dates or ISO text, numbers against numbers or numeric text, text against text.
// Anything else is not ordered, so `<`/`>` are false instead of guessing.
function ordered(a, b) {
  if (a instanceof Date || b instanceof Date) { const x = toDate(a), y = toDate(b); return x && y ? [x.getTime(), y.getTime()] : null; }
  if (typeof a === "number" || typeof b === "number") { const x = toNumber(a), y = toNumber(b); return x === null || y === null ? null : [x, y]; }
  if (typeof a === "string" && typeof b === "string") return [a, b];
  if (typeof a === "boolean" && typeof b === "boolean") return [+a, +b];
  return null;
}
function equal(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]));
  const pair = ordered(a, b);
  return pair ? pair[0] === pair[1] : JSON.stringify(a) === JSON.stringify(b);
}
const tagKey = tag => String(tag).replace(/^#/, "").normalize("NFC").toLowerCase();

function fileValue(record, name) {
  switch (name) {
    case "properties": return record.properties;
    case "tags": return record.tags;
    case "folder": return record.folder || "/";
    default: return record[name];
  }
}
// Column and sort ids: `file.name`, `note.status`, plain `status`; `formula.*` and `this.*` are not evaluated.
export function propertyGetter(id) {
  const [scope, ...rest] = String(id).split("."), field = rest.join(".");
  if (scope === "file" && fileFields.has(field)) return record => fileValue(record, field);
  if (scope === "formula" || scope === "this" || scope === "file") return null;
  const key = scope === "note" && field ? field : String(id);
  return record => record.properties[key];
}

function compile(node) {
  switch (node.type) {
    case "literal": return () => node.value;
    case "list": { const items = node.items.map(compile); return record => items.map(item => item(record)); }
    case "unary": {
      const argument = compile(node.argument);
      return node.op === "!" ? record => !truthy(argument(record)) : record => { const value = toNumber(argument(record)); return value === null ? null : -value; };
    }
    case "binary": {
      const left = compile(node.left), right = compile(node.right);
      switch (node.op) {
        case "&&": return record => truthy(left(record)) && truthy(right(record));
        case "||": return record => truthy(left(record)) || truthy(right(record));
        case "==": return record => equal(left(record), right(record));
        case "!=": return record => !equal(left(record), right(record));
        case "<": case ">": case "<=": case ">=": {
          const test = { "<": (x, y) => x < y, ">": (x, y) => x > y, "<=": (x, y) => x <= y, ">=": (x, y) => x >= y }[node.op];
          return record => { const pair = ordered(left(record), right(record)); return !!pair && test(pair[0], pair[1]); };
        }
        default: return record => arithmetic(node.op, left(record), right(record));
      }
    }
    case "name":
      if (node.name === "file" || node.name === "note") throw new Unsupported(`"${node.name}" needs a property`);
      if (node.name === "formula" || node.name === "this") throw new Unsupported(`${node.name}.* is not supported yet`);
      if (globals.has(node.name)) throw new Unsupported(`${node.name} needs ()`);
      return record => record.properties[node.name];
    case "member": return member(node);
    case "call": return call(node);
  }
  throw new Unsupported("unknown expression");
}
function arithmetic(op, a, b) {
  // Notes carry dates as ISO text; a duration on the right makes the left side a date.
  if ((op === "+" || op === "-") && typeof b === "string" && /^\s*\d+\s*[A-Za-z]+\s*$/.test(b) && toDate(a)) return shift(toDate(a), b, op === "+" ? 1 : -1);
  if (op === "-" && (a instanceof Date || b instanceof Date) && toDate(a) && toDate(b)) return toDate(a).getTime() - toDate(b).getTime();
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  const x = toNumber(a), y = toNumber(b);
  if (x === null || y === null) return null;
  return op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : op === "/" ? (y ? x / y : null) : y ? x % y : null;
}
function member(node) {
  const scope = node.object.type === "name" ? node.object.name : null;
  const key = node.key ? (node.key.type === "literal" && typeof node.key.value === "string" ? node.key.value : null) : node.name;
  if (scope === "file") {
    if (key === null || !fileFields.has(key)) throw new Unsupported(`file.${key ?? "[…]"} is not supported yet`);
    return record => fileValue(record, key);
  }
  if (scope === "note") {
    if (key === null) throw new Unsupported("note[…] needs a quoted name");
    return record => record.properties[key];
  }
  if (scope === "formula" || scope === "this") throw new Unsupported(`${scope}.* is not supported yet`);
  const object = compile(node.object);
  if (node.key) {
    const index = compile(node.key);
    return record => { const value = object(record), at = index(record); return Array.isArray(value) && typeof at === "number" ? value[at < 0 ? value.length + at : at] ?? null : plain(value) && typeof at === "string" ? value[at] ?? null : null; };
  }
  if (node.name === "length") return record => { const value = object(record); return typeof value === "string" || Array.isArray(value) ? value.length : null; };
  if (["year", "month", "day", "hour", "minute", "second"].includes(node.name)) return record => {
    const date = toDate(object(record));
    return date && { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() }[node.name];
  };
  throw new Unsupported(`.${node.name} is not supported yet`);
}
function call(node) {
  const args = node.args.map(compile), callee = node.callee;
  if (callee.type === "name") {
    if (!globals.has(callee.name)) throw new Unsupported(`${callee.name}() is not supported yet`);
    switch (callee.name) {
      case "now": return () => new Date();
      case "today": return () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); };
      case "date": return record => toDate(args[0]?.(record));
      case "number": return record => { const value = args[0]?.(record); return typeof value === "boolean" ? +value : value instanceof Date ? value.getTime() : toNumber(value); };
      case "list": return record => { const value = args[0]?.(record); return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]; };
      case "if": return record => truthy(args[0]?.(record)) ? args[1]?.(record) ?? null : args[2]?.(record) ?? null;
    }
  }
  if (callee.type !== "member" || !callee.name) throw new Unsupported("only named functions can be called");
  const scope = callee.object.type === "name" ? callee.object.name : null;
  if (scope === "file") {
    if (callee.name === "hasTag") return record => args.some(arg => { const wanted = tagKey(arg(record)); return record.tagKeys.some(tag => tag === wanted || tag.startsWith(wanted + "/")); });
    if (callee.name === "inFolder") return record => {
      const folder = String(args[0]?.(record) ?? "").replace(/^\/+|\/+$/g, "");
      return !folder || record.path.normalize("NFC").toLowerCase().startsWith(folder.normalize("NFC").toLowerCase() + "/");
    };
    if (callee.name === "hasProperty") return record => Object.hasOwn(record.properties, String(args[0]?.(record) ?? ""));
    throw new Unsupported(`file.${callee.name}() is not supported yet`);
  }
  if (!methods.has(callee.name)) throw new Unsupported(`.${callee.name}() is not supported yet`);
  const object = compile(callee.object), name = callee.name;
  return record => method(name, object(record), args.map(arg => arg(record)));
}
function method(name, value, args) {
  const fold = item => typeof item === "string" ? item.normalize("NFC").toLowerCase() : item;
  const has = needle => Array.isArray(value) ? value.some(item => equal(item, needle)) : typeof value === "string" && typeof needle === "string" && value.includes(needle);
  switch (name) {
    case "contains": return has(args[0]);
    case "containsAll": return args.every(has);
    case "containsAny": return args.some(has);
    case "startsWith": return typeof value === "string" && typeof args[0] === "string" && value.startsWith(args[0]);
    case "endsWith": return typeof value === "string" && typeof args[0] === "string" && value.endsWith(args[0]);
    case "lower": return typeof value === "string" ? fold(value) : value ?? null;
    case "upper": return typeof value === "string" ? value.toUpperCase() : value ?? null;
    case "trim": return typeof value === "string" ? value.trim() : value ?? null;
    case "isEmpty": return empty(value);
    case "isTruthy": return truthy(value);
    case "toString": return text(value);
    case "date": { const date = toDate(value); return date && new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
  }
  return null;
}

// ---- filters -----------------------------------------------------------------------------------------------------
// Each node evaluates to true, false or null (not evaluated). Unsupported parts never hide rows: `and` ignores them,
// `or` keeps the row, `not` only excludes on a known true. The result is flagged incomplete so the view says so.
function compileFilter(filter, where, diagnostics, count = { nodes: 0 }) {
  if (filter === undefined || filter === null) return null;
  if (++count.nodes > baseLimits.filters) { diagnostics.push({ code: "filter-limit", where }); return () => null; }
  if (typeof filter === "string" || typeof filter === "number" || typeof filter === "boolean") {
    try { const run = compile(parseExpression(String(filter))); return record => truthy(run(record)); }
    catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      diagnostics.push({ code: "filter", where, detail: String(filter), reason: error.message });
      return () => null;
    }
  }
  const keys = plain(filter) ? Object.keys(filter) : [];
  if (keys.length !== 1 || !["and", "or", "not"].includes(keys[0]) || !Array.isArray(filter[keys[0]])) {
    diagnostics.push({ code: "filter", where, detail: JSON.stringify(filter).slice(0, 200), reason: "expected and/or/not with a list" });
    return () => null;
  }
  const mode = keys[0], items = filter[mode].map(item => compileFilter(item, where, diagnostics, count)).filter(Boolean);
  if (mode === "and") return record => { let unknown = false; for (const item of items) { const value = item(record); if (value === false) return false; if (value === null) unknown = true; } return unknown ? null : true; };
  if (mode === "or") return record => { let unknown = false; for (const item of items) { const value = item(record); if (value === true) return true; if (value === null) unknown = true; } return unknown ? null : false; };
  return record => { let unknown = false; for (const item of items) { const value = item(record); if (value === true) return false; if (value === null) unknown = true; } return unknown ? null : true; };
}

// ---- base files --------------------------------------------------------------------------------------------------
export function parseBase(source) {
  const diagnostics = [];
  if (typeof source !== "string" || source.length > baseLimits.bytes) return { error: "too-large", views: [], diagnostics };
  let data;
  try { data = source.trim() ? parse(source, { maxAliasCount: 20, uniqueKeys: true, prettyErrors: false }) : {}; }
  catch (error) { return { error: "yaml", message: String(error?.message ?? error).split("\n")[0], views: [], diagnostics }; }
  if (data === null || data === undefined) data = {};
  if (!plain(data)) return { error: "shape", views: [], diagnostics };
  for (const key of Object.keys(data)) if (!topKeys.has(key)) diagnostics.push({ code: "key", detail: key });
  if (plain(data.formulas)) for (const name of Object.keys(data.formulas)) diagnostics.push({ code: "formula", detail: name });
  if (data.summaries !== undefined) diagnostics.push({ code: "summaries" });
  const labels = new Map();
  if (plain(data.properties)) for (const [id, config] of Object.entries(data.properties)) {
    if (plain(config) && typeof config.displayName === "string") labels.set(id.startsWith("note.") ? id.slice(5) : id, config.displayName);
  }
  const label = id => labels.get(id.startsWith("note.") ? id.slice(5) : id);
  const global = compileFilter(data.filters, "global", diagnostics);
  const declared = Array.isArray(data.views) ? data.views.slice(0, baseLimits.views) : [];
  if (Array.isArray(data.views) && data.views.length > baseLimits.views) diagnostics.push({ code: "view-limit" });
  if (data.views !== undefined && !Array.isArray(data.views)) diagnostics.push({ code: "views" });
  const views = (declared.length ? declared : [{ type: "table", name: "" }]).map((view, index) => {
    view = plain(view) ? view : {};
    const name = typeof view.name === "string" && view.name.trim() ? view.name.trim() : `View ${index + 1}`;
    const type = typeof view.type === "string" ? view.type : "table";
    if (!viewTypes.has(type)) diagnostics.push({ code: "view-type", view: name, detail: type });
    if (view.groupBy !== undefined) diagnostics.push({ code: "group-by", view: name });
    if (view.summaries !== undefined) diagnostics.push({ code: "summaries", view: name });
    const columns = [];
    for (const id of Array.isArray(view.order) && view.order.length ? view.order : ["file.name"]) {
      const get = typeof id === "string" ? propertyGetter(id) : null;
      if (get) columns.push({ id, label: label(id), get });
      // A declared formula column already has its "not calculated" notice.
      else if (!(typeof id === "string" && id.startsWith("formula.") && plain(data.formulas) && Object.hasOwn(data.formulas, id.slice(8)))) diagnostics.push({ code: "column", view: name, detail: String(id) });
    }
    const sort = [];
    for (const item of Array.isArray(view.sort) ? view.sort : []) {
      const get = plain(item) && typeof item.property === "string" ? propertyGetter(item.property) : null;
      if (get) sort.push({ id: item.property, get, descending: String(item.direction).toUpperCase() === "DESC" });
      else diagnostics.push({ code: "sort", view: name, detail: plain(item) ? String(item.property) : String(item) });
    }
    const limit = Number.isInteger(view.limit) && view.limit > 0 ? view.limit : null;
    if (view.limit !== undefined && limit === null) diagnostics.push({ code: "limit", view: name, detail: String(view.limit) });
    return { name, type: viewTypes.has(type) ? type : "table", declaredType: type, columns, sort, limit, filter: compileFilter(view.filters, name, diagnostics), image: typeof view.image === "string" ? view.image : null };
  });
  return { views, diagnostics, labels: Object.fromEntries(labels), global };
}

// ---- notes -------------------------------------------------------------------------------------------------------
const fence = /^(?: {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;
function bodyTags(body) {
  const visible = body.replace(fence, "").replace(/`[^`\n]*`/g, "");
  return [...visible.matchAll(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)].map(match => match[2]);
}
const encoder = new TextEncoder();
// A row: file facts from the stamp, properties from YAML (missing key = undefined, written `null` = null), tags from
// front matter plus the body outside code. Notes with broken front matter keep file facts and get no properties.
export function noteRecord({ relative, content, modified, created }) {
  const path = String(relative).replaceAll("\\", "/"), name = path.split("/").at(-1) ?? path;
  let properties = {}, body = content, broken = false;
  try {
    const fm = frontmatter(content);
    body = fm.body;
    const values = fm.document.toJS({ maxAliasCount: 50 });
    if (plain(values)) properties = values;
  } catch { broken = true; }
  properties = Object.assign(Object.create(null), properties);
  const declared = [properties.tags, properties.tag].flat().flatMap(tag => typeof tag === "string" ? tag.split(/[\s,]+/) : []).map(tag => tag.replace(/^#/, "")).filter(Boolean);
  const tags = [...new Set([...declared, ...bodyTags(body)])];
  const time = seconds => { const value = Number(seconds); return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null; };
  return {
    path, name, basename: name.replace(/\.[^.]+$/, ""), folder: path.split("/").slice(0, -1).join("/"), ext: /\.([^./]+)$/.exec(name)?.[1] ?? "",
    size: encoder.encode(content).length, ctime: time(created), mtime: time(modified), properties, tags, tagKeys: tags.map(tagKey), broken,
  };
}

// Keeps one record per note and re-parses only notes whose text or stamp changed; deleted notes drop out.
export function createBaseIndex() {
  const entries = new Map();
  let list = null;
  return {
    update(notes) {
      const seen = new Set(), changed = [];
      for (const note of notes) {
        const relative = note.relative.replaceAll("\\", "/");
        seen.add(relative);
        const previous = entries.get(relative);
        if (previous && previous.content === note.content && previous.modified === note.modified && previous.created === note.created) continue;
        entries.set(relative, { content: note.content, modified: note.modified, created: note.created, record: noteRecord({ ...note, relative }) });
        changed.push(relative);
      }
      for (const relative of entries.keys()) if (!seen.has(relative)) { entries.delete(relative); changed.push(relative); }
      if (changed.length) list = null;
      return changed;
    },
    records() { return list ??= [...entries.values()].map(entry => entry.record); },
  };
}

const typeRank = value => value instanceof Date ? 1 : typeof value === "number" ? 0 : typeof value === "boolean" ? 2 : 3;
function compareValues(a, b) {
  const aEmpty = empty(a), bEmpty = empty(b);
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const pair = ordered(a, b);
  if (pair && typeof pair[0] === "string") return collator.compare(pair[0], pair[1]);
  if (pair) return pair[0] < pair[1] ? -1 : pair[0] > pair[1] ? 1 : 0;
  return typeRank(a) - typeRank(b) || collator.compare(text(a), text(b));
}
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

// Runs one view over the records: global and view filters, stable typed sort with the vault path as the last key,
// then the view's limit. Rows carry raw values for the renderer plus their display text.
export function evaluateBase(base, viewName, records) {
  const view = base.views.find(item => item.name === viewName) ?? base.views[0];
  if (!view) return { view: null, columns: [], rows: [], total: 0, incomplete: false };
  let unknown = false;
  const matched = [];
  for (const record of records) {
    const results = [base.global?.(record), view.filter?.(record)];
    if (results.includes(false)) continue;
    if (results.includes(null)) unknown = true;
    matched.push(record);
  }
  const keyed = matched.map(record => ({ record, keys: view.sort.map(item => item.get(record)) }));
  keyed.sort((a, b) => {
    for (let index = 0; index < view.sort.length; index++) {
      const order = compareValues(a.keys[index], b.keys[index]);
      if (order) return view.sort[index].descending && !empty(a.keys[index]) && !empty(b.keys[index]) ? -order : order;
    }
    return byPath(a.record, b.record);
  });
  const shown = keyed.slice(0, Math.min(view.limit ?? Infinity, baseLimits.rows));
  const columns = view.columns.map(({ id, label }) => ({ id, label }));
  const rows = shown.map(({ record }) => ({ path: record.path, name: record.basename, values: view.columns.map(column => { const value = column.get(record); return { value: value ?? null, text: text(value) }; }) }));
  return { view: view.name, type: view.type, columns, rows, total: matched.length, limited: shown.length < matched.length, incomplete: unknown || base.diagnostics.some(item => (item.code === "filter" || item.code === "filter-limit") && (item.where === "global" || item.where === view.name)) };
}

export const baseFile = relative => /\.base$/i.test(String(relative ?? ""));
