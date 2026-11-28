// Dataview evaluator and query engine, ported from blacksmithgu/obsidian-dataview (MIT)
// src/expression/{context,binaryop,functions}.ts, src/query/engine.ts, src/data-index/resolver.ts
// and the frontmatter typing of src/data-import/markdown-file.ts. Provenance: third-party/obsidian-ports/NOTICE.
// Pages come from an in-memory snapshot of the open folder; nothing here reads files, the network or the DOM.
import { t } from "../../i18n.ts";
import { referenceIndex } from "../../../shared/references.mjs";
import { properties } from "../../../shared/frontmatter.mjs";
import type { PortSnapshot } from "./capabilities.ts";
import type { VaultSnapshot } from "../../types.ts";
import { compareValue, Duration, DvDate, isTruthy, Link, typeOf, valueText, type Callable, type Literal, type LiteralType } from "./dataview-values.ts";
import { parseDate, parseDatePlus, parseDuration, parseEmbedLink, QueryError, type BinaryOp, type Field, type Query, type Source } from "./dataview-query.ts";

type Data = Record<string, Literal>;
export interface Page { relative: string; data: Data; outgoing: string[]; unresolved: string[] }
export interface DataviewIndex {
  pages: Map<string, Page>;
  truncated: boolean;
  /** Resolve a link target written in `origin` to a page path. */
  resolve(origin: string, target: string): string | null;
}
export type QueryOutput = ({ type: "table"; names: string[]; rows: Literal[][] } | { type: "list"; items: { id?: Literal; value: Literal }[] }) & { warnings: string[]; scanned: number };

/** Aborts the whole query rather than one row: budget exhaustion and source errors. */
class QueryAbort extends QueryError {}

const STEP_LIMIT = 2_000_000, DEPTH_LIMIT = 256, TEXT_LIMIT = 1_000_000;
const MARKDOWN = /\.(md|markdown|mdown)$/i;
const UNAVAILABLE_FILE_FIELDS: Record<string, true> = { ctime: true, cday: true, mtime: true, mday: true, starred: true, lists: true, tasks: true };

// ---------------------------------------------------------------------------------------------
// Index: snapshot -> Dataview pages (file.* metadata plus typed frontmatter).

/** Canonical variable name, as Dataview's canonicalizeVarName: lower case, spaces to dashes, symbols dropped. */
export function canonicalName(name: string) {
  return name.replace(/\p{Extended_Pictographic}|[0-9\p{L}_-]+|\s|./gsu, part => /^\p{Extended_Pictographic}$/u.test(part) ? part : /^[0-9\p{L}_-]+$/u.test(part) ? part.toLocaleLowerCase() : /^\s$/.test(part) ? "-" : "");
}

/** Plain YAML value as a Dataview literal: dates, durations and links in strings are typed. */
export function frontmatterValue(value: unknown): Literal {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(frontmatterValue);
  if (value instanceof Date) return new DvDate(value.getTime());
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return parseDate(value) ?? parseDuration(value) ?? parseEmbedLink(value) ?? value;
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frontmatterValue(item)]));
  return String(value);
}

function rawValue(value: unknown): Literal {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(rawValue);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rawValue(item)]));
  return String(value);
}

function splitList(value: unknown, on: RegExp): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter(Boolean).flatMap(item => splitList(item, on));
  return String(value).split(on).map(item => item.trim()).filter(Boolean);
}

function fileDay(name: string, fields: Data): Literal {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(name) || /(\d{4})(\d{2})(\d{2})/.exec(name);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= new Date(year, month, 0).getDate()) return DvDate.local(year, month, day);
  }
  return fields.date instanceof DvDate ? fields.date : null;
}

/** Shape used from shared/references.mjs referenceIndex(); vendor.d.ts declares it untyped. */
interface ReferenceNote { relative: string; content: string; tags: string[]; headings: unknown[] }
interface References {
  notes: ReferenceNote[];
  edges: { source: ReferenceNote; ref: { target: string; image: boolean }; state: string; candidates: { relative: string }[] }[];
  resolve(from: { relative: string; headings: unknown[] }, raw: string, wiki: boolean): { candidates: { relative: string }[] };
}
const slash = (path: string) => path.replaceAll("\\", "/");

export function buildIndex(snapshot: PortSnapshot): DataviewIndex {
  // referenceIndex reads only relative/content/assets; `token` is used by bundlePlan alone, so ports never see it.
  const references = referenceIndex(snapshot as unknown as VaultSnapshot) as References;
  const pages = new Map<string, Page>(), notes = new Map<string, ReferenceNote>();
  const outgoing = new Map<string, { links: Link[]; resolved: string[]; unresolved: string[] }>();
  for (const edge of references.edges) {
    if (edge.state === "external" || edge.state === "escape" || edge.state === "invalid") continue;
    const source = slash(edge.source.relative), target = edge.candidates.length === 1 ? slash(edge.candidates[0].relative) : null;
    const entry = outgoing.get(source) ?? { links: [], resolved: [], unresolved: [] };
    outgoing.set(source, entry);
    const fragment = edge.ref.target.includes("#") ? edge.ref.target.slice(edge.ref.target.indexOf("#")) : "";
    entry.links.push(Link.infer((target ?? edge.ref.target.split("#")[0]) + fragment, !!edge.ref.image));
    if (target) entry.resolved.push(target); else entry.unresolved.push(edge.ref.target.split("#")[0].trim().toLowerCase());
  }
  const incoming = new Map<string, Set<string>>();
  for (const [source, entry] of outgoing) for (const target of entry.resolved) {
    if (!incoming.has(target)) incoming.set(target, new Set());
    incoming.get(target)!.add(source);
  }
  for (const note of references.notes) {
    const relative = slash(note.relative);
    if (!MARKDOWN.test(relative)) continue;
    notes.set(relative, note);
    let metadata: Record<string, unknown> = {};
    try { metadata = properties(note.content); } catch { /* Invalid YAML reads as no frontmatter, as in Dataview. */ }
    const fields: Data = {};
    for (const [key, value] of Object.entries(metadata)) fields[key] = frontmatterValue(value);
    for (const [key, value] of Object.entries(fields)) { const name = canonicalName(key); if (name && !(name in fields)) fields[name] = value; }
    const tagKeys = Object.keys(metadata).filter(key => /^tags?$/i.test(key));
    const explicit = [...new Set([...(note.tags as string[]).map(tag => "#" + tag), ...tagKeys.flatMap(key => splitList(metadata[key], /[,\s]+/)).map(tag => tag.startsWith("#") ? tag : "#" + tag)])];
    const expanded = [...new Set(explicit.flatMap(tag => tag.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))))];
    const aliases = Object.keys(metadata).filter(key => /^alias(es)?$/i.test(key)).flatMap(key => Array.isArray(metadata[key]) ? (metadata[key] as unknown[]).map(item => String(item).trim()) : splitList(metadata[key], /,/));
    const name = relative.split("/").at(-1)!.replace(MARKDOWN, ""), entry = outgoing.get(relative);
    const file: Data = {
      path: relative, folder: relative.split("/").slice(0, -1).join("/"), name, link: new Link(relative), ext: relative.split(".").at(-1)!.toLowerCase(),
      size: new TextEncoder().encode(note.content).length, outlinks: entry?.links ?? [], inlinks: [...incoming.get(relative) ?? []].sort().map(source => new Link(source)),
      etags: explicit, tags: expanded, aliases, frontmatter: rawValue(metadata), day: fileDay(name, fields),
    };
    pages.set(relative, { relative, data: { ...fields, file }, outgoing: entry?.resolved ?? [], unresolved: entry?.unresolved ?? [] });
  }
  return {
    pages, truncated: !!snapshot.truncated,
    resolve(origin, target) {
      if (pages.has(target)) return target;
      const from = notes.get(origin) ?? { relative: origin, headings: [] };
      const result = references.resolve(from, target, true);
      return result.candidates.length === 1 ? slash(result.candidates[0].relative) : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Values in text, and Luxon-style date formatting for dateformat().

/** String conversion used by `+` and string(): links stay wiki links so the renderer can make them clickable. */
export function textOf(value: Literal, locale: string): string {
  if (value instanceof Link) return value.markdown();
  if (Array.isArray(value)) return value.map(item => textOf(item, locale)).join(", ");
  return valueText(value, locale);
}

const pad = (value: number, size: number) => String(Math.trunc(Math.abs(value))).padStart(size, "0");
export function formatDate(date: DvDate, format: string, locale: string): string {
  const value = date.date, name = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value);
  const tokens: Record<string, () => string> = {
    yyyy: () => pad(date.year, 4), yy: () => pad(date.year % 100, 2), y: () => String(date.year),
    MMMM: () => name({ month: "long", day: "numeric" }).replace(/\d+\s*\.?/g, "").trim(), MMM: () => name({ month: "short", day: "numeric" }).replace(/\d+\s*\.?/g, "").trim(),
    LLLL: () => name({ month: "long" }), LLL: () => name({ month: "short" }), MM: () => pad(date.month, 2), M: () => String(date.month), LL: () => pad(date.month, 2), L: () => String(date.month),
    dd: () => pad(date.day, 2), d: () => String(date.day), EEEE: () => name({ weekday: "long" }), EEE: () => name({ weekday: "short" }), E: () => String(date.weekday),
    cccc: () => name({ weekday: "long" }), ccc: () => name({ weekday: "short" }), c: () => String(date.weekday),
    HH: () => pad(date.hour, 2), H: () => String(date.hour), hh: () => pad(date.hour % 12 || 12, 2), h: () => String(date.hour % 12 || 12),
    mm: () => pad(date.minute, 2), m: () => String(date.minute), ss: () => pad(date.second, 2), s: () => String(date.second), SSS: () => pad(date.millisecond, 3),
    a: () => new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true }).formatToParts(value).find(part => part.type === "dayPeriod")?.value ?? (date.hour < 12 ? "AM" : "PM"),
    WW: () => pad(date.weekyear, 2), W: () => String(date.weekyear), ooo: () => pad((value.getTime() - new Date(date.year, 0, 1).getTime()) / 86_400_000 + 1, 3),
    D: () => name({ dateStyle: "short" }), DD: () => name({ dateStyle: "medium" }), DDD: () => name({ dateStyle: "long" }), DDDD: () => name({ dateStyle: "full" }),
    t: () => name({ timeStyle: "short" }), T: () => name({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
  return format.replace(/'([^']*)'|yyyy|yy|y|MMMM|MMM|MM|M|LLLL|LLL|LL|L|dd|d|EEEE|EEE|E|cccc|ccc|c|HH|H|hh|h|mm|m|ss|s|SSS|a|WW|W|ooo|DDDD|DDD|DD|D|t|T/g,
    (token, literal: string | undefined) => literal !== undefined ? literal || "'" : tokens[token]());
}

// ---------------------------------------------------------------------------------------------
// Evaluation context.

type Impl = (context: Context, ...args: Literal[]) => Literal;
/** A typed variant: FunctionBuilder checks argument types before calling it, so parameters may be narrowed. */
type Variant = (context: Context, ...args: never[]) => Literal;
type ArgType = LiteralType | "*";

export class Context {
  steps = 0;
  private depth = 0;
  readonly index: DataviewIndex;
  readonly origin: string;
  readonly locale: string;
  readonly globals: Data;
  constructor(index: DataviewIndex, origin: string, locale: string, globals: Data = {}) { this.index = index; this.origin = origin; this.locale = locale; this.globals = globals; }

  normalize = (link: Link) => this.index.resolve(this.origin, link.path) ?? link.path;
  page(link: Link): Data | null { const path = this.index.resolve(this.origin, link.path); return path ? this.index.pages.get(path)?.data ?? null : null; }

  evaluate(field: Field, data: Data = {}): Literal {
    if (++this.steps > STEP_LIMIT) throw new QueryAbort(t("This query is too expensive. Narrow FROM or WHERE and try again."));
    if (++this.depth > DEPTH_LIMIT) { this.depth = 0; throw new QueryAbort(t("This query is nested too deeply.")); }
    try { return this.evaluateField(field, data); } finally { this.depth--; }
  }

  private evaluateField(field: Field, data: Data): Literal {
    switch (field.type) {
      case "literal": return field.value;
      case "variable": return field.name in data ? data[field.name] : field.name in this.globals ? this.globals[field.name] : null;
      case "negated": return !isTruthy(this.evaluate(field.child, data));
      case "binaryop": return binaryOp(field.op, this.evaluate(field.left, data), this.evaluate(field.right, data), this);
      case "list": return field.values.map(child => this.evaluate(child, data));
      case "object": return Object.fromEntries(Object.entries(field.values).map(([key, child]) => [key, this.evaluate(child, data)]));
      case "lambda": return ((context: Context, ...args: Literal[]) => {
        const scope = { ...data };
        field.arguments.forEach((name, index) => { if (index < args.length) scope[name] = args[index]; });
        return context.evaluate(field.value, scope);
      }) as Callable;
      case "function": {
        const target = field.func.type === "variable" ? field.func.name : this.evaluate(field.func, data);
        const args = field.arguments.map(argument => this.evaluate(argument, data));
        if (typeof target === "function") return (target as Impl)(this, ...args);
        if (typeof target === "string") {
          const denied = DENIED_FUNCTIONS[target.toLowerCase()];
          if (denied) throw new QueryAbort(t("{{name}}() is not available in Omarkie: {{reason}}", { name: target, reason: denied() }));
          const implementation = FUNCTIONS[target.toLowerCase()];
          if (!implementation) throw new QueryAbort(t("Unknown function {{name}}().", { name: target }));
          return implementation(this, ...args);
        }
        throw new QueryError(t("Cannot call a {{type}} as a function.", { type: typeOf(target) }));
      }
      case "index": {
        const index = this.evaluate(field.index, data);
        if (index === null) return null;
        if (typeof index !== "string" && typeof index !== "number") throw new QueryError(t("Can only index with text or a number."));
        const object = field.object.type === "variable" && field.object.name === "row" ? { ...this.globals, ...data } : this.evaluate(field.object, data);
        return this.indexValue(object, index);
      }
    }
  }

  indexValue(object: Literal, index: string | number): Literal {
    switch (typeOf(object)) {
      case "object": return typeof index === "string" ? (object as Data)[index] ?? null : (() => { throw new QueryError(t("Objects are indexed with text, like a.b or a[\"b\"].")); })();
      case "link": {
        if (typeof index !== "string") throw new QueryError(t("Links are indexed with text, like link.field."));
        return this.page(object as Link)?.[index] ?? null;
      }
      case "array": {
        const list = object as Literal[];
        if (typeof index === "number") return index >= 0 && index < list.length ? list[index] : null;
        const result: Literal[] = [];
        for (const value of list) { try { result.push(this.indexValue(value, index)); } catch (error) { if (error instanceof QueryAbort) throw error; } }
        return result;
      }
      case "string": {
        if (typeof index !== "number") throw new QueryError(t("Text is indexed with a number, like text[0]."));
        const text = object as string;
        return index >= 0 && index < text.length ? text[index] : null;
      }
      case "date": {
        if (typeof index !== "string") throw new QueryError(t("Dates are indexed with a unit name, like date.year."));
        const date = object as DvDate;
        const parts: Record<string, () => number> = { year: () => date.year, month: () => date.month, weekyear: () => date.weekyear, week: () => Math.floor(date.day / 7) + 1, weekday: () => date.weekday, day: () => date.day, hour: () => date.hour, minute: () => date.minute, second: () => date.second, millisecond: () => date.millisecond };
        return parts[index]?.() ?? null;
      }
      case "duration": {
        if (typeof index !== "string") throw new QueryError(t("Durations are indexed with a unit name, like duration.days."));
        const millis = (object as Duration).toMillis();
        const units: Record<string, number> = { year: 365 * 86_400_000, month: 30 * 86_400_000, week: 7 * 86_400_000, day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1000, millisecond: 1 };
        const unit = units[index.replace(/s$/, "")];
        return unit && (index !== "week") ? millis / unit : null;
      }
      default: return null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Binary operators (createBinaryOps).

const DAY = 86_400_000;
function dateDifference(left: DvDate, right: DvDate): Duration {
  const sign = left.ms >= right.ms ? 1 : -1, [late, early] = sign > 0 ? [left, right] : [right, left];
  let months = (late.year - early.year) * 12 + (late.month - early.month);
  if (early.plus(new Duration(months)).ms > late.ms) months--;
  const anchor = early.plus(new Duration(months)), rest = late.ms - anchor.ms, days = Math.floor(rest / DAY);
  return new Duration(sign * months, sign * days, sign * (rest - days * DAY));
}

function repeat(text: string, count: number) {
  if (count < 0) return "";
  if (text.length * count > TEXT_LIMIT) throw new QueryError(t("Text result is too long."));
  return text.repeat(count);
}

export function binaryOp(op: BinaryOp, left: Literal, right: Literal, context: Context): Literal {
  if (op === "&") return isTruthy(left) && isTruthy(right);
  if (op === "|") return isTruthy(left) || isTruthy(right);
  if (op === "=" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    const order = compareValue(left, right, context.normalize);
    return op === "=" ? order === 0 : op === "!=" ? order !== 0 : op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0;
  }
  const leftType = typeOf(left), rightType = typeOf(right);
  const pair = `${leftType} ${op} ${rightType}`;
  if (leftType === "number" && rightType === "number") {
    const a = left as number, b = right as number;
    return op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : a % b;
  }
  if (op === "+" && leftType === "string") return checked(left as string + textOf(right, context.locale));
  if (op === "+" && rightType === "string") return checked(textOf(left, context.locale) + (right as string));
  if (op === "*" && leftType === "string" && rightType === "number") return repeat(left as string, right as number);
  if (op === "*" && leftType === "number" && rightType === "string") return repeat(right as string, left as number);
  switch (pair) {
    case "date - date": return dateDifference(left as DvDate, right as DvDate);
    case "date - duration": return (left as DvDate).plus(right as Duration, -1);
    case "date + duration": return (left as DvDate).plus(right as Duration);
    case "duration + date": return (right as DvDate).plus(left as Duration);
    case "duration + duration": return (left as Duration).plus(right as Duration);
    case "duration - duration": return (left as Duration).plus(right as Duration, -1);
    case "duration / number": return (left as Duration).scale(1 / (right as number));
    case "duration * number": return (left as Duration).scale(right as number);
    case "number * duration": return (right as Duration).scale(left as number);
    case "array + array": return [...left as Literal[], ...right as Literal[]];
    case "object + object": return { ...left as Data, ...right as Data };
    case "null + null": case "null - null": case "null * null": case "null / null": case "null % null":
    case "date + null": case "null + date": case "date - null": case "null - date": return null;
  }
  throw new QueryError(t("No operator for {{pair}}.", { pair }));
}

function checked(text: string) {
  if (text.length > TEXT_LIMIT) throw new QueryError(t("Text result is too long."));
  return text;
}

// ---------------------------------------------------------------------------------------------
// Functions (DefaultFunctions), with typed variants and vectorization like FunctionBuilder.

class FunctionBuilder {
  private variants: { args: ArgType[]; varargs: boolean; impl: Variant }[] = [];
  private vectorized: Record<number, number[]> = {};
  readonly name: string;
  constructor(name: string) { this.name = name; }
  add(args: ArgType[], impl: Variant) { this.variants.push({ args, varargs: false, impl }); return this; }
  vararg(impl: Impl) { this.variants.push({ args: [], varargs: true, impl }); return this; }
  vectorize(count: number, positions: number[]) { this.vectorized[count] = positions; return this; }
  build(): Impl {
    const self: Impl = (context, ...args: Literal[]) => {
      const types = args.map(typeOf);
      const positions = this.vectorized[types.length]?.filter(position => types[position] === "array");
      if (positions?.length) {
        const length = Math.min(...positions.map(position => (args[position] as Literal[]).length)), result: Literal[] = [];
        for (let item = 0; item < length; item++) result.push(self(context, ...args.map((arg, position) => positions.includes(position) ? (arg as Literal[])[item] : arg)));
        return result;
      }
      for (const variant of this.variants) {
        if (variant.varargs) return (variant.impl as Impl)(context, ...args);
        if (variant.args.length === types.length && variant.args.every((type, position) => type === "*" || type === types[position])) return (variant.impl as Impl)(context, ...args);
      }
      throw new QueryError(t("No version of {{name}}() takes {{types}}.", { name: this.name, types: types.join(", ") || t("no arguments") }));
    };
    return self;
  }
}

const call = (context: Context, fn: Literal, ...args: Literal[]) => (fn as Impl)(context, ...args);
const nullOut = (count: number) => Array.from({ length: count }, (_, position) => Array.from({ length: count }, (_, index) => index === position ? "null" : "*") as ArgType[]);
function withNulls(builder: FunctionBuilder, count: number) { for (const args of nullOut(count)) builder.add(args, () => null); return builder; }
const NUMBER = /-?[0-9]+(\.[0-9]+)?/;

const reduce: Impl = new FunctionBuilder("reduce")
  .add(["array", "string"], (context, list: Literal[], op: string) => {
    if (!list.length) return null;
    if (!["+", "-", "*", "/", "&", "|"].includes(op)) throw new QueryError(t("reduce(list, op) supports +, -, *, /, & and |."));
    return list.slice(1).reduce((value: Literal, item) => binaryOp(op as BinaryOp, value, item, context), list[0]);
  })
  .add(["array", "function"], (context, list: Literal[], fn) => list.length ? list.slice(1).reduce((value: Literal, item) => item === null ? value : call(context, fn, value, item), list[0]) : null)
  .add(["null", "*"], () => null).add(["*", "null"], () => null).vectorize(2, [1]).build();

const contains = (name: string, deep: boolean, fold: (text: string) => string): Impl => {
  const self: Impl = new FunctionBuilder(name)
    .add(["array", "*"], (context, list: Literal[], item) => list.some(element => deep ? self(context, element, item) : binaryOp("=", item, element, context)))
    .add(["string", "string"], (_context, haystack: string, needle: string) => fold(haystack).includes(fold(needle)))
    .add(["object", "string"], (_context, object: Data, key: string) => key in object)
    .add(["*", "*"], (context, a, b) => binaryOp("=", a, b, context))
    .vectorize(2, [1]).build();
  return self;
};

const string: Impl = new FunctionBuilder("string").add(["*"], (context, value) => textOf(value, context.locale)).build();
const join: Impl = new FunctionBuilder("join")
  .add(["array", "string"], (context, list: Literal[], separator: string) => list.map(item => textOf(item, context.locale)).join(separator))
  .add(["array", "null"], (context, list: Literal[]) => list.map(item => textOf(item, context.locale)).join(", "))
  .add(["*", "string"], (context, value) => textOf(value, context.locale))
  .add(["array"], (context, list: Literal[]) => list.map(item => textOf(item, context.locale)).join(", "))
  .add(["*"], (context, value) => textOf(value, context.locale))
  .vectorize(2, [1]).build();
const minimum: Impl = new FunctionBuilder("min")
  .add(["*", "null"], (_context, a) => a).add(["null", "*"], (_context, _null, a) => a)
  .add(["*", "*"], (context, a, b) => compareValue(a, b, context.normalize) <= 0 ? a : b)
  .add(["array"], (context, list: Literal[]) => minimum(context, ...list))
  .vararg((context, ...args: Literal[]) => args.length ? args.reduce((a, b) => minimum(context, a, b)) : null).build();
const maximum: Impl = new FunctionBuilder("max")
  .add(["*", "null"], (_context, a) => a).add(["null", "*"], (_context, _null, a) => a)
  .add(["*", "*"], (context, a, b) => compareValue(a, b, context.normalize) > 0 ? a : b)
  .add(["array"], (context, list: Literal[]) => maximum(context, ...list))
  .vararg((context, ...args: Literal[]) => args.length ? args.reduce((a, b) => maximum(context, a, b)) : null).build();
const by = (name: string, better: (order: number) => boolean): Impl => new FunctionBuilder(name)
  .add(["array", "function"], (context, list: Literal[], fn) => {
    if (!list.length) return null;
    const mapped = list.map(value => ({ value, key: call(context, fn, value) })).filter(item => item.key !== null);
    if (!mapped.length) return list[0];
    return mapped.reduce((best, item) => better(compareValue(best.key, item.key, context.normalize)) ? best : item).value;
  })
  .add(["null", "function"], () => null).build();
const sortList: Impl = new FunctionBuilder("sort")
  .add(["array"], (context, list: Literal[]) => sortList(context, list, ((_context: Context, value: Literal) => value) as Callable))
  .add(["array", "function"], (context, list: Literal[], key) => [...list].sort((a, b) => {
    const left = call(context, key, a), right = call(context, key, b);
    return isTruthy(binaryOp("<", left, right, context)) ? -1 : isTruthy(binaryOp("=", left, right, context)) ? 0 : 1;
  }))
  .add(["*"], (_context, value) => value).build();
const truncate: Impl = withNulls(new FunctionBuilder("truncate")
  .add(["string", "number", "string"], (_context, text: string, length: number, suffix: string) => text.length > length - suffix.length ? text.substring(0, Math.max(0, length - suffix.length)) + suffix : text)
  .add(["string", "number"], (context, text, length) => truncate(context, text, length, "...")), 3)
  .add(["null", "*"], () => null).add(["*", "null"], () => null).vectorize(2, [0, 1]).vectorize(3, [0, 1, 2]).build();
const sum: Impl = new FunctionBuilder("sum").add(["array"], (context, list) => reduce(context, list, "+")).add(["*"], (_context, value) => value).build();

const padding = (name: string, side: "padStart" | "padEnd") => withNulls(new FunctionBuilder(name)
  .add(["string", "number"], (_context, text: string, length: number) => checked(text[side](Math.min(length, TEXT_LIMIT + 1), " ")))
  .add(["string", "number", "string"], (_context, text: string, length: number, fill: string) => checked(text[side](Math.min(length, TEXT_LIMIT + 1), fill))), 3)
  .add(["null", "*"], () => null).add(["*", "null"], () => null).vectorize(2, [0, 1]).vectorize(3, [0, 1, 2]).build();

const truthyBy = (name: string, test: (list: Literal[], check: (value: Literal) => boolean) => boolean) => new FunctionBuilder(name)
  .add(["array"], (_context, list: Literal[]) => test(list, isTruthy))
  .add(["array", "function"], (context, list: Literal[], fn) => test(list, value => isTruthy(call(context, fn, value))))
  .vararg((_context, ...args: Literal[]) => test(args, isTruthy)).build();

const unary = (name: string, impl: (value: never, context: Context) => Literal, type: ArgType) =>
  new FunctionBuilder(name).add([type], (context, value) => impl(value, context)).add(["null"], () => null).vectorize(1, [0]).build();

const dateFunction: Impl = new FunctionBuilder("date")
  .add(["string"], (_context, text: string) => parseDatePlus(text))
  .add(["date"], (_context, date) => date)
  .add(["link"], (context, link: Link) => (link.display ? parseDate(link.display) : null) ?? parseDate(link.path) ?? (context.page(link)?.file as Data | undefined)?.day ?? null)
  .add(["string", "string"], (_context, text: string, format: string) => {
    if (format === "x" || format === "X") {
      const match = NUMBER.exec(text);
      if (!match) throw new QueryError(t("Not a number for format {{format}}: {{text}}", { format, text }));
      return new DvDate(Number.parseInt(match[0]) * (format === "X" ? 1000 : 1));
    }
    throw new QueryError(t("date(text, format) supports only the x and X formats here; write dates as YYYY-MM-DD."));
  })
  .add(["null", "string"], () => null).add(["null"], () => null).vectorize(1, [0]).build();

const literalSplit = (text: string, separator: string, limit?: number) => {
  if (/[\\^$.*+?()[\]{}|]/.test(separator)) throw new QueryError(t("split() accepts a plain text separator here, without regular expression symbols."));
  return text.split(separator, limit).map(part => part || "");
};

export const FUNCTIONS: Record<string, Impl> = {
  object: (_context, ...args: Literal[]) => {
    if (args.length % 2) throw new QueryError(t("object() needs pairs of key and value."));
    const result: Data = {};
    for (let index = 0; index < args.length; index += 2) {
      if (typeof args[index] !== "string") throw new QueryError(t("object() keys must be text."));
      result[args[index] as string] = args[index + 1];
    }
    return result;
  },
  list: (_context, ...args) => args,
  array: (_context, ...args) => args,
  date: dateFunction,
  dur: new FunctionBuilder("dur").add(["string"], (_context, text: string) => parseDuration(text.trim())).add(["duration"], (_context, value) => value).add(["null"], () => null).vectorize(1, [0]).build(),
  number: new FunctionBuilder("number").add(["number"], (_context, value) => value).add(["string"], (_context, text: string) => { const match = NUMBER.exec(text); return match ? Number.parseFloat(match[0]) : null; }).add(["null"], () => null).vectorize(1, [0]).build(),
  string,
  link: (() => {
    const link: Impl = new FunctionBuilder("link")
      .add(["string"], (context, path: string) => new Link(context.index.resolve(context.origin, path) ?? path))
      .add(["link"], (_context, value) => value).add(["null"], () => null).vectorize(1, [0])
      .add(["string", "string"], (context, path: string, display: string) => new Link(context.index.resolve(context.origin, path) ?? path, false, display))
      .add(["string", "string", "boolean"], (context, path: string, display: string, embed: boolean) => new Link(context.index.resolve(context.origin, path) ?? path, embed, display))
      .add(["link", "string"], (_context, value: Link, display: string) => value.withDisplay(display))
      .add(["null", "*"], () => null).add(["*", "null"], (context, value) => link(context, value)).vectorize(2, [0, 1]).build();
    return link;
  })(),
  embed: new FunctionBuilder("embed").add(["link"], (_context, link: Link) => new Link(link.path, true, link.display, link.subpath, link.type)).vectorize(1, [0])
    .add(["link", "boolean"], (_context, link: Link, embed: boolean) => new Link(link.path, embed, link.display, link.subpath, link.type))
    .add(["null"], () => null).add(["null", "*"], () => null).add(["*", "null"], () => null).vectorize(2, [0, 1]).build(),
  typeof: new FunctionBuilder("typeof").add(["*"], (_context, value) => typeOf(value)).build(),
  round: new FunctionBuilder("round").add(["number"], (_context, value: number) => Math.round(value)).add(["null"], () => null).vectorize(1, [0])
    .add(["number", "number"], (_context, value: number, places: number) => places <= 0 ? Math.round(value) : Number.parseFloat(value.toFixed(Math.min(places, 100))))
    .add(["number", "null"], (_context, value: number) => Math.round(value)).add(["null", "*"], () => null).vectorize(2, [0]).build(),
  trunc: unary("trunc", Math.trunc, "number"),
  floor: unary("floor", Math.floor, "number"),
  ceil: unary("ceil", Math.ceil, "number"),
  min: minimum,
  max: maximum,
  sum,
  product: new FunctionBuilder("product").add(["array"], (context, list) => reduce(context, list, "*")).add(["*"], (_context, value) => value).build(),
  average: new FunctionBuilder("average").add(["array"], (context, list: Literal[]) => {
    if (!list.length) return null;
    const total = sum(context, list);
    return total === null ? null : binaryOp("/", total, list.length, context);
  }).add(["*"], (_context, value) => value).build(),
  minby: by("minby", order => order <= 0),
  maxby: by("maxby", order => order > 0),
  contains: contains("contains", true, text => text),
  icontains: contains("icontains", true, text => text.toLocaleLowerCase()),
  econtains: contains("econtains", false, text => text),
  containsword: withNulls(new FunctionBuilder("containsword").add(["string", "string"], (_context, haystack: string, needle: string) =>
    new RegExp("\\b" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(haystack)), 2).vectorize(2, [0, 1]).build(),
  extract: (context, ...args: Literal[]): Literal => {
    if (!args.length) throw new QueryError(t("extract(object, key, …) needs an object."));
    const [object, ...keys] = args;
    if (Array.isArray(object)) return object.map(value => FUNCTIONS.extract(context, value, ...keys));
    const result: Data = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new QueryError(t("extract() keys must be text."));
      result[key] = object === null ? null : context.indexValue(object, key);
    }
    return result;
  },
  sort: sortList,
  reverse: new FunctionBuilder("reverse").add(["array"], (_context, list: Literal[]) => [...list].reverse()).add(["string"], (_context, text: string) => [...text].reverse().join("")).add(["*"], (_context, value) => value).build(),
  length: new FunctionBuilder("length").add(["array"], (_context, list: Literal[]) => list.length).add(["object"], (_context, object: Data) => Object.keys(object).length).add(["string"], (_context, text: string) => text.length).add(["null"], () => 0).build(),
  nonnull: new FunctionBuilder("nonnull").add(["array"], (_context, list: Literal[]) => list.filter(value => value !== null)).vararg((_context, ...args: Literal[]) => args.filter(value => value !== null)).build(),
  firstvalue: new FunctionBuilder("firstvalue").add(["array"], (_context, list: Literal[]) => list.find(value => value !== null) ?? null).add(["null"], () => null).build(),
  all: truthyBy("all", (list, check) => list.every(check)),
  any: truthyBy("any", (list, check) => list.some(check)),
  none: truthyBy("none", (list, check) => !list.some(check)),
  join,
  filter: new FunctionBuilder("filter").add(["array", "function"], (context, list: Literal[], fn) => list.filter(value => isTruthy(call(context, fn, value)))).add(["null", "*"], () => null).build(),
  map: new FunctionBuilder("map").add(["array", "function"], (context, list: Literal[], fn) => list.map(value => call(context, fn, value))).add(["null", "*"], () => null).build(),
  flat: new FunctionBuilder("flat").add(["array"], (_context, list: Literal[]) => list.flat() as Literal[]).add(["array", "number"], (_context, list: unknown[], depth: number) => list.flat(Math.min(depth, 64)) as Literal[]).add(["null"], () => null).build(),
  slice: new FunctionBuilder("slice").add(["array"], (_context, list: Literal[]) => list.slice()).add(["array", "number"], (_context, list: Literal[], start: number) => list.slice(start))
    .add(["array", "number", "number"], (_context, list: Literal[], start: number, end: number) => list.slice(start, end)).add(["null"], () => null).build(),
  unique: new FunctionBuilder("unique").add(["array"], (context, list: Literal[]) => list.filter((value, index) => list.findIndex(other => compareValue(value, other, context.normalize) === 0) === index)).add(["null"], () => null).build(),
  reduce,
  replace: withNulls(new FunctionBuilder("replace").add(["string", "string", "string"], (_context, text: string, pattern: string, replacement: string) => checked(text.split(pattern).join(replacement))), 3).vectorize(3, [0, 1, 2]).build(),
  lower: unary("lower", (text: string) => text.toLocaleLowerCase(), "string"),
  upper: unary("upper", (text: string) => text.toLocaleUpperCase(), "string"),
  split: withNulls(new FunctionBuilder("split").add(["string", "string"], (_context, text: string, separator: string) => literalSplit(text, separator))
    .add(["string", "string", "number"], (_context, text: string, separator: string, limit: number) => literalSplit(text, separator, limit)), 3).add(["null", "*"], () => null).add(["*", "null"], () => null).build(),
  startswith: withNulls(new FunctionBuilder("startswith").add(["string", "string"], (_context, text: string, prefix: string) => text.startsWith(prefix)), 2).vectorize(2, [0, 1]).build(),
  endswith: withNulls(new FunctionBuilder("endswith").add(["string", "string"], (_context, text: string, suffix: string) => text.endsWith(suffix)), 2).vectorize(2, [0, 1]).build(),
  padleft: padding("padleft", "padStart"),
  padright: padding("padright", "padEnd"),
  substring: withNulls(new FunctionBuilder("substring").add(["string", "number"], (_context, text: string, start: number) => text.substring(start))
    .add(["string", "number", "number"], (_context, text: string, start: number, end: number) => text.substring(start, end)), 3).add(["null", "*"], () => null).add(["*", "null"], () => null).vectorize(2, [0, 1]).vectorize(3, [0, 1, 2]).build(),
  truncate,
  default: new FunctionBuilder("default").add(["*", "*"], (_context, value, fallback) => value === null ? fallback : value).vectorize(2, [0, 1]).build(),
  ldefault: new FunctionBuilder("ldefault").add(["*", "*"], (_context, value, fallback) => value === null ? fallback : value).build(),
  display: (() => {
    const display: Impl = new FunctionBuilder("display").add(["null"], () => "").add(["array"], (context, list: Literal[]) => list.map(value => display(context, value)).join(", "))
      .add(["link"], (_context, link: Link) => link.label()).add(["*"], (context, value) => valueText(value, context.locale)).build();
    return display;
  })(),
  choice: new FunctionBuilder("choice").add(["*", "*", "*"], (_context, test, left, right) => isTruthy(test) ? left : right).vectorize(3, [0]).build(),
  striptime: unary("striptime", (date: DvDate) => date.startOfDay(), "date"),
  dateformat: new FunctionBuilder("dateformat").add(["date", "string"], (context, date: DvDate, format: string) => formatDate(date, format, context.locale)).add(["null", "string"], () => null).vectorize(2, [0]).build(),
  currencyformat: new FunctionBuilder("currencyformat")
    .add(["number", "string"], (context, value: number, currency: string) => new Intl.NumberFormat(context.locale, { style: "currency", currency }).format(value))
    .add(["null", "string"], () => null).add(["number"], (context, value: number) => new Intl.NumberFormat(context.locale, { style: "currency", currency: "USD" }).format(value))
    .add(["null"], () => null).vectorize(2, [0]).build(),
  localtime: unary("localtime", (date: DvDate) => date, "date"),
  meta: new FunctionBuilder("meta").add(["link"], (_context, link: Link) => ({ display: link.display ?? null, embed: link.embed, path: link.path, subpath: link.subpath ?? null, type: link.type })).build(),
};

/** Upstream functions deliberately left out, with the reason shown to the user. */
const DENIED_FUNCTIONS: Record<string, () => string> = {
  regextest: () => t("queries cannot run regular expressions."),
  regexmatch: () => t("queries cannot run regular expressions."),
  regexreplace: () => t("queries cannot run regular expressions."),
  elink: () => t("queries cannot create web links."),
  durationformat: () => t("use string() or the duration's units, like d.days."),
  hash: () => t("use sort() or file.name for a stable order."),
};

// ---------------------------------------------------------------------------------------------
// Sources and execution (resolveSource, executeCore, executeTable, executeList).

function sourcePaths(source: Source, index: DataviewIndex, origin: string): Set<string> {
  const all = () => new Set(index.pages.keys());
  switch (source.type) {
    case "empty": return all();
    case "folder": {
      const folder = source.folder.replace(/^\/+|\/+$/g, "");
      if (!folder) return all();
      const inside = [...index.pages.keys()].filter(path => path.startsWith(folder + "/"));
      if (inside.length) return new Set(inside);
      return new Set([folder, folder + ".md"].filter(path => index.pages.has(path)));
    }
    case "tag": {
      const tag = source.tag.toLowerCase();
      return new Set([...index.pages.values()].filter(page => ((page.data.file as Data).tags as string[]).some(item => item.toLowerCase() === tag)).map(page => page.relative));
    }
    case "link": {
      const target = index.resolve(origin, source.file);
      if (source.direction === "outgoing") {
        if (!target) throw new QueryAbort(t("Could not find the note “{{name}}” for outgoing().", { name: source.file }));
        return new Set(index.pages.get(target)!.outgoing.filter(path => index.pages.has(path)));
      }
      const raw = source.file.trim().toLowerCase();
      return new Set([...index.pages.values()].filter(page => target ? page.outgoing.includes(target) : page.unresolved.includes(raw)).map(page => page.relative));
    }
    case "negate": { const child = sourcePaths(source.child, index, origin); return new Set([...index.pages.keys()].filter(path => !child.has(path))); }
    case "binaryop": {
      const left = sourcePaths(source.left, index, origin), right = sourcePaths(source.right, index, origin);
      return source.op === "&" ? new Set([...right].filter(path => left.has(path))) : new Set([...left, ...right]);
    }
  }
}

type Row = { id: Literal; data: Data };

function failAll(operation: string, errors: string[]): never {
  throw new QueryError(t("Every row failed during {{operation}}: {{message}}", { operation, message: [...new Set(errors)].slice(0, 3).join(" · ") }));
}

function rowError(error: unknown, errors: string[]) {
  if (error instanceof QueryAbort || !(error instanceof Error)) throw error;
  if (error instanceof RangeError && !(error instanceof QueryError)) throw new QueryAbort(t("This query is nested too deeply."));
  errors.push(error.message);
}

function executeCore(rows: Row[], context: Context, query: Query): { rows: Row[]; group?: string } {
  let group: string | undefined;
  const ordered = (a: Literal, b: Literal) => isTruthy(binaryOp("<", a, b, context)) ? -1 : isTruthy(binaryOp(">", a, b, context)) ? 1 : 0;
  for (const operation of query.operations) {
    const incoming = rows.length, errors: string[] = [];
    switch (operation.type) {
      case "where":
        rows = rows.filter(row => { try { return isTruthy(context.evaluate(operation.clause, row.data)); } catch (error) { rowError(error, errors); return false; } });
        break;
      case "sort": {
        const tagged: { row: Row; keys: Literal[] }[] = [];
        for (const row of rows) { try { tagged.push({ row, keys: operation.fields.map(field => context.evaluate(field.field, row.data)) }); } catch (error) { rowError(error, errors); } }
        tagged.sort((a, b) => {
          for (const [position, field] of operation.fields.entries()) {
            const order = ordered(a.keys[position], b.keys[position]);
            if (order) return field.direction === "ascending" ? order : -order;
          }
          return 0;
        });
        rows = tagged.map(item => item.row);
        break;
      }
      case "limit": {
        const amount = context.evaluate(operation.amount);
        if (typeof amount !== "number") throw new QueryError(t("LIMIT needs a number, not {{type}}.", { type: typeOf(amount) }));
        rows = rows.slice(0, amount);
        break;
      }
      case "group": {
        const keyed: { row: Row; key: Literal }[] = [];
        for (const row of rows) { try { keyed.push({ row, key: context.evaluate(operation.field.field, row.data) }); } catch (error) { rowError(error, errors); } }
        keyed.sort((a, b) => ordered(a.key, b.key));
        const groups: { key: Literal; rows: Data[] }[] = [];
        for (const item of keyed) {
          const last = groups.at(-1);
          if (last && isTruthy(binaryOp("=", item.key, last.key, context))) last.rows.push(item.row.data);
          else groups.push({ key: item.key, rows: [item.row.data] });
        }
        rows = groups.map(item => ({ id: item.key, data: { key: item.key, rows: item.rows, [operation.field.name]: item.key } }));
        group = operation.field.name;
        break;
      }
      case "flatten": {
        const flattened: Row[] = [];
        for (const row of rows) {
          try {
            const value = context.evaluate(operation.field.field, row.data);
            for (const item of Array.isArray(value) ? value : [value]) flattened.push({ id: row.id, data: { ...row.data, [operation.field.name]: item } });
          } catch (error) { rowError(error, errors); }
        }
        rows = flattened;
        if (group === operation.field.name) group = undefined;
        break;
      }
    }
    if (incoming > 0 && errors.length >= incoming) failAll(operation.type.toUpperCase(), errors);
  }
  return { rows, group };
}

function unavailableFields(query: Query): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const field = value as Field;
    if (field.type === "index" && field.object.type === "variable" && field.object.name === "file" && field.index.type === "literal" && typeof field.index.value === "string" && UNAVAILABLE_FILE_FIELDS[field.index.value]) found.add("file." + field.index.value);
    for (const child of Object.values(value)) if (child && typeof child === "object" && !(child instanceof Link) && !(child instanceof DvDate) && !(child instanceof Duration)) visit(child);
  };
  visit(query);
  return [...found];
}

/** Run a parsed TABLE or LIST query against the index, from the note at `origin`. */
export function executeQuery(query: Query, index: DataviewIndex, origin: string, locale: string): QueryOutput {
  const context = new Context(index, origin, locale, { this: index.pages.get(origin)?.data ?? {} });
  const pages = [...sourcePaths(query.source, index, origin)].map(path => index.pages.get(path)!).filter(Boolean)
    .map(page => ({ id: page.data.file && (page.data.file as Data).link, data: page.data }) as Row);
  const core = executeCore(pages, context, query);
  const fields = query.header.type === "table" ? query.header.fields : query.header.format ? [{ name: "target", field: query.header.format }] : [];
  const extracted: Row[] = [], errors: string[] = [];
  for (const row of core.rows) {
    try { extracted.push({ id: row.id, data: Object.fromEntries(fields.map(field => [field.name, context.evaluate(field.field, row.data)])) }); }
    catch (error) { rowError(error, errors); }
  }
  if (core.rows.length > 0 && errors.length >= core.rows.length) failAll(t("columns"), errors);
  const warnings = unavailableFields(query).map(name => t("{{name}} is not available in Omarkie and reads as empty.", { name }));
  if (index.truncated) warnings.push(t("The folder is too large to index completely; results may be partial."));
  if (query.header.type === "table") {
    const header = query.header;
    const names = [...header.showId ? [core.group ?? t("File")] : [], ...header.fields.map(field => field.name)];
    return { type: "table", names, rows: extracted.map(row => [...header.showId ? [row.id] : [], ...header.fields.map(field => row.data[field.name] ?? null)]), warnings, scanned: index.pages.size };
  }
  const format = query.header.format, showId = query.header.showId;
  return { type: "list", items: extracted.map(row => format ? (showId ? { id: row.id, value: row.data.target ?? null } : { value: row.data.target ?? null }) : { value: row.id }), warnings, scanned: index.pages.size };
}
