// Dataview Query Language parser, ported from blacksmithgu/obsidian-dataview (MIT)
// src/expression/parse.ts and src/query/parse.ts. Provenance: third-party/obsidian-ports/NOTICE.
// Parsimmon combinators become a hand-written recursive descent parser with the same grammar;
// TASK and CALENDAR views and csv() sources are out of scope and rejected with a clear message.
import { t } from "../../i18n.ts";
import { Duration, DvDate, Link, type Literal } from "./dataview-values.ts";

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "=" | "!=" | "<" | ">" | "<=" | ">=" | "&" | "|";
export type Field =
  | { type: "literal"; value: Literal }
  | { type: "variable"; name: string }
  | { type: "list"; values: Field[] }
  | { type: "object"; values: Record<string, Field> }
  | { type: "binaryop"; left: Field; op: BinaryOp; right: Field }
  | { type: "negated"; child: Field }
  | { type: "index"; object: Field; index: Field }
  | { type: "function"; func: Field; arguments: Field[] }
  | { type: "lambda"; arguments: string[]; value: Field };
export type Source =
  | { type: "empty" }
  | { type: "folder"; folder: string }
  | { type: "tag"; tag: string }
  | { type: "link"; file: string; direction: "incoming" | "outgoing" }
  | { type: "negate"; child: Source }
  | { type: "binaryop"; op: "&" | "|"; left: Source; right: Source };
export interface NamedField { name: string; field: Field }
export interface SortField { field: Field; direction: "ascending" | "descending" }
export type Operation =
  | { type: "where"; clause: Field }
  | { type: "sort"; fields: SortField[] }
  | { type: "limit"; amount: Field }
  | { type: "group"; field: NamedField }
  | { type: "flatten"; field: NamedField };
export type Header = { type: "table"; fields: NamedField[]; showId: boolean } | { type: "list"; format?: Field; showId: boolean };
export interface Query { header: Header; source: Source; operations: Operation[] }

/** A query the parser or engine rejected; line and column point at the furthest parse failure. */
export class QueryError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line = 0, column = 0) { super(message); this.name = "QueryError"; this.line = line; this.column = column; }
}

class Backtrack extends Error {}
const KEYWORDS: Record<string, true> = { FROM: true, WHERE: true, LIMIT: true, GROUP: true, FLATTEN: true };
const BOUNDARY = "(?![\\p{L}\\p{N}_-])";
const DURATION_UNITS: [string, (amount: number) => Duration][] = (
  [
    [["years", "year", "yrs", "yr"], amount => new Duration(amount * 12)],
    [["months", "month", "mos", "mo"], amount => new Duration(amount)],
    [["weeks", "week", "wks", "wk", "w"], amount => new Duration(0, amount * 7)],
    [["days", "day", "d"], amount => new Duration(0, amount)],
    [["hours", "hour", "hrs", "hr", "h"], amount => new Duration(0, 0, amount * 3_600_000)],
    [["minutes", "minute", "mins", "min", "m"], amount => new Duration(0, 0, amount * 60_000)],
    [["seconds", "second", "secs", "sec", "s"], amount => new Duration(0, 0, amount * 1000)],
  ] as [string[], (amount: number) => Duration][]
).flatMap(([names, make]) => names.map(name => [name, make] as [string, (amount: number) => Duration])).sort((a, b) => b[0].length - a[0].length);

function startOf(unit: "week" | "month" | "year", now = new Date()) {
  if (unit === "year") return DvDate.local(now.getFullYear());
  if (unit === "month") return DvDate.local(now.getFullYear(), now.getMonth() + 1);
  return DvDate.local(now.getFullYear(), now.getMonth() + 1, now.getDate() - ((now.getDay() + 6) % 7));
}
function endOf(unit: "week" | "month" | "year") {
  const start = startOf(unit).date;
  if (unit === "year") start.setFullYear(start.getFullYear() + 1); else if (unit === "month") start.setMonth(start.getMonth() + 1); else start.setDate(start.getDate() + 7);
  return new DvDate(start.getTime() - 1);
}
const today = () => DvDate.local(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
const DATE_SHORTHANDS: [string, () => DvDate][] = ([
  ["now", () => new DvDate(Date.now())], ["today", today],
  ["yesterday", () => today().plus(new Duration(0, -1))], ["tomorrow", () => today().plus(new Duration(0, 1))],
  ["sow", () => startOf("week")], ["start-of-week", () => startOf("week")], ["eow", () => endOf("week")], ["end-of-week", () => endOf("week")],
  ["soy", () => startOf("year")], ["start-of-year", () => startOf("year")], ["eoy", () => endOf("year")], ["end-of-year", () => endOf("year")],
  ["som", () => startOf("month")], ["start-of-month", () => startOf("month")], ["eom", () => endOf("month")], ["end-of-month", () => endOf("month")],
] as [string, () => DvDate][]).sort((a, b) => b[0].length - a[0].length);

function zoneOffset(zone: string, utc: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utc)).map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(utc / 1000) * 1000;
}

class Parser {
  index = 0;
  private furthest = 0;
  private expected = new Set<string>();
  readonly text: string;
  constructor(text: string) { this.text = text; }

  fail(expected: string): never {
    if (this.index > this.furthest) { this.furthest = this.index; this.expected = new Set(); }
    if (this.index === this.furthest) this.expected.add(expected);
    throw new Backtrack();
  }
  error(): QueryError {
    const before = this.text.slice(0, this.furthest).split("\n"), line = before.length, column = before.at(-1)!.length + 1;
    const found = this.text.slice(this.furthest).match(/^\S{0,20}/)![0];
    return new QueryError(t("Expected {{expected}} at line {{line}}, column {{column}}, found {{found}}.", {
      expected: this.expected.has(t("expression")) ? t("expression") : [...this.expected].join(", "), line, column, found: found ? `“${found}”` : t("end of query"),
    }), line, column);
  }
  /** Match a sticky regex at the cursor; advance and return the match, or null. */
  eat(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.index;
    const match = pattern.exec(this.text);
    if (match) this.index += match[0].length;
    return match;
  }
  need(pattern: RegExp, expected: string): RegExpExecArray { return this.eat(pattern) ?? this.fail(expected); }
  attempt<T>(rule: () => T): T | null {
    const start = this.index;
    try { return rule(); } catch (error) { if (error instanceof Backtrack) { this.index = start; return null; } throw error; }
  }
  first<T>(...rules: (() => T)[]): T | null {
    for (const rule of rules) { const value = this.attempt(rule); if (value !== null) return value; }
    return null;
  }
  ws() { this.eat(/\s*/y); }
  ws1() { this.need(/\s+/y, t("whitespace")); }
  wsComments() { while (this.eat(/\s+/y) || this.eat(/\/\/[^\n]*/y)); }
  eof() { return this.index >= this.text.length; }

  // Literals.
  number(): number { return Number(this.need(/-?[0-9]+(\.[0-9]+)?/y, t("number"))[0]); }
  string(): string {
    this.need(/"/y, "\"");
    let value = "";
    for (;;) {
      const escape = this.eat(/\\(.)/sy);
      if (escape) { value += escape[1] === "\"" || escape[1] === "\\" ? escape[1] : "\\" + escape[1]; continue; }
      const plain = this.eat(/[^"\\]+/y);
      if (plain) { value += plain[0]; continue; }
      this.need(/"/y, "\"");
      return value;
    }
  }
  bool(): boolean { return this.need(new RegExp(`(true|false)${BOUNDARY}`, "iuy"), "true, false")[1].toLowerCase() === "true"; }
  identifier(): string { return this.need(/(?:\p{L}|\p{Extended_Pictographic})(?:[0-9\p{L}_-]|\p{Extended_Pictographic})*/uy, t("variable"))[0]; }
  tag(): string { return this.need(/#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/y, "#tag")[0]; }
  link(): Link {
    const match = this.need(/\[\[([^[\]]*?)\]\]/y, "[[link]]");
    return parseInnerLink(match[1]);
  }
  embedLink(): Link {
    const embed = !!this.eat(/!/y), link = this.link();
    return embed ? new Link(link.path, true, link.display, link.subpath, link.type) : link;
  }
  date(): DvDate {
    const year = Number(this.need(/[+-]?[0-9]{4}(?![0-9])/y, t("date"))[0]);
    this.need(/-/y, "-");
    const month = Number(this.need(/[0-9]{2}/y, t("month"))[0]);
    let day = 1, hour = 0, minute = 0, second = 0, millisecond = 0, zone: string | number | undefined;
    const step = (rule: () => void) => this.attempt(() => { rule(); return true; }) ?? false;
    if (step(() => { this.need(/-/y, "-"); day = Number(this.need(/[0-9]{2}/y, t("day"))[0]); })
      && step(() => { this.need(/T/y, "T"); hour = Number(this.need(/[0-9]{2}/y, t("hour"))[0]); })
      && step(() => { this.need(/:/y, ":"); minute = Number(this.need(/[0-9]{2}/y, t("minute"))[0]); })
      && step(() => { this.need(/:/y, ":"); second = Number(this.need(/[0-9]{2}/y, t("second"))[0]); })) {
      step(() => { this.need(/\./y, "."); millisecond = Number(this.need(/[0-9]{3}/y, t("milliseconds"))[0]); });
    }
    step(() => {
      const offset = this.eat(/([+-])([0-9]{1,2})(?::([0-9]{2}))?/y);
      if (offset) { zone = (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)); return; }
      if (this.eat(/Z/y)) { zone = 0; return; }
      zone = this.need(/\[([0-9A-Za-z+\-/_]+)\]/y, "[zone]")[1];
    });
    if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate() || hour > 23 || minute > 59 || second > 59) this.fail(t("valid date"));
    if (zone === undefined) return DvDate.local(year, month, day, hour, minute, second, millisecond);
    const utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    if (typeof zone === "number") return new DvDate(utc - zone * 60_000);
    try { return new DvDate(utc - zoneOffset(zone, utc)); } catch { return this.fail(t("time zone")); }
  }
  datePlus(): DvDate {
    for (const [name, make] of DATE_SHORTHANDS) if (this.eat(new RegExp(name.replace(/-/g, "\\-"), "y"))) return make();
    return this.date();
  }
  duration(): Duration {
    let total = new Duration();
    const part = () => {
      const amount = this.number();
      this.ws();
      const unit = DURATION_UNITS.find(([name]) => this.eat(new RegExp(name, "iy")));
      return unit ? unit[1](amount) : this.fail(t("duration unit"));
    };
    total = part();
    for (;;) {
      const next = this.attempt(() => { this.eat(/\s*,?\s*/y); return part(); });
      if (!next) return total;
      total = total.plus(next);
    }
  }

  // Expressions.
  field(): Field { return this.binary(() => this.compare(), new RegExp(`(?:(and|or)${BOUNDARY}|&|\\|)`, "iuy"), op => /^and$|^&$/i.test(op) ? "&" : "|"); }
  compare(): Field { return this.binary(() => this.plusMinus(), /(>=|<=|!=|>|<|=)/y, op => op as BinaryOp); }
  plusMinus(): Field { return this.binary(() => this.mulDiv(), /[+-]/y, op => op as BinaryOp); }
  mulDiv(): Field { return this.binary(() => this.indexed(), /[*/%]/y, op => op as BinaryOp); }
  binary(child: () => Field, operator: RegExp, op: (text: string) => BinaryOp): Field {
    let left = child();
    for (;;) {
      const start = this.index;
      this.ws();
      const match = this.eat(operator);
      if (!match) { this.index = start; return left; }
      this.ws();
      const right = this.attempt(child);
      if (!right) { this.index = start; return left; }
      left = { type: "binaryop", left, op: op(match[0]), right };
    }
  }
  indexed(): Field {
    let value = this.atom();
    for (;;) {
      const next = this.first<Field>(
        () => { this.need(/\./y, "."); return { type: "index", object: value, index: { type: "literal", value: this.identifier() } }; },
        () => { this.need(/\[/y, "["); this.ws(); const index = this.field(); this.ws(); this.need(/\]/y, "]"); return { type: "index", object: value, index }; },
        () => { this.need(/\(/y, "("); this.ws(); const args = this.list(() => this.field()); this.ws(); this.need(/\)/y, ")"); return { type: "function", func: value, arguments: args }; },
      );
      if (!next) return value;
      value = next;
    }
  }
  list<T>(item: () => T, separator = /\s*,\s*/y): T[] {
    const first = this.attempt(item);
    if (first === null) return [];
    const values = [first];
    for (;;) {
      const next = this.attempt(() => { this.need(separator, ","); return item(); });
      if (next === null) return values;
      values.push(next);
    }
  }
  atom(): Field {
    const literal = (value: Literal): Field => ({ type: "literal", value });
    const value = this.first<Field>(
      () => literal(this.embedLink()),
      () => { this.need(/!/y, "!"); return { type: "negated", child: this.indexed() }; },
      () => { this.need(/\[/y, "["); this.ws(); const values = this.list(() => this.field()); this.ws(); this.need(/\]/y, "]"); return { type: "list", values }; },
      () => {
        this.need(/\{/y, "{"); this.ws();
        const entries = this.list(() => { const key = this.first(() => this.identifier(), () => this.string()) ?? this.fail(t("key")); this.ws(); this.need(/:/y, ":"); this.ws(); return [key, this.field()] as const; });
        this.ws(); this.need(/\}/y, "}");
        return { type: "object", values: Object.fromEntries(entries) };
      },
      () => {
        this.need(/\(/y, "("); this.ws();
        const names = this.list(() => this.identifier());
        this.ws(); this.need(/\)/y, ")"); this.ws(); this.need(/=>/y, "=>"); this.ws();
        return { type: "lambda", arguments: names, value: this.field() };
      },
      () => { this.need(/\(/y, "("); this.ws(); const inner = this.field(); this.ws(); this.need(/\)/y, ")"); return inner; },
      () => literal(this.bool()),
      () => literal(this.number()),
      () => literal(this.string()),
      () => { this.need(/date\(/iy, "date("); this.ws(); const date = this.datePlus(); this.ws(); this.need(/\)/y, ")"); return literal(date); },
      () => { this.need(/dur\(/iy, "dur("); this.ws(); const duration = this.duration(); this.ws(); this.need(/\)/y, ")"); return literal(duration); },
      () => { this.need(new RegExp(`null${BOUNDARY}`, "iuy"), "null"); return literal(null); },
      () => {
        const start = this.index, name = this.identifier();
        if (KEYWORDS[name.toUpperCase()]) { this.index = start; this.fail(t("variable")); }
        return { type: "variable", name };
      },
    );
    return value ?? this.fail(t("expression"));
  }
  namedField(): NamedField {
    return this.first(
      () => { const field = this.field(); this.ws1(); this.need(/AS/iy, "AS"); this.ws1(); const name = this.first(() => this.identifier(), () => this.string()) ?? this.fail(t("column name")); return { name, field }; },
      () => { const start = this.index, field = this.field(); return { name: this.text.slice(start, this.index).replace(/[\r\n]/g, ""), field }; },
    ) ?? this.fail(t("expression"));
  }

  // Sources.
  source(): Source { return this.sourceBinary(); }
  sourceBinary(): Source {
    let left = this.sourceAtom();
    for (;;) {
      const start = this.index;
      this.ws();
      const match = this.eat(new RegExp(`(?:(and|or)${BOUNDARY}|&|\\|)`, "iuy"));
      if (!match) { this.index = start; return left; }
      this.ws();
      const right = this.attempt(() => this.sourceAtom());
      if (!right) { this.index = start; return left; }
      left = { type: "binaryop", op: /^and$|^&$/i.test(match[0]) ? "&" : "|", left, right };
    }
  }
  sourceAtom(): Source {
    const source = this.first<Source>(
      () => { this.need(/\(/y, "("); this.ws(); const inner = this.source(); this.ws(); this.need(/\)/y, ")"); return inner; },
      () => { this.need(/[-!]/y, "-"); return { type: "negate", child: this.sourceAtom() }; },
      () => ({ type: "tag", tag: this.tag() }),
      () => ({ type: "folder", folder: this.string() }),
      () => { this.need(/outgoing\(/iy, "outgoing("); this.ws(); const link = this.link(); this.ws(); this.need(/\)/y, ")"); return { type: "link", file: link.path, direction: "outgoing" }; },
      () => ({ type: "link", file: this.link().path, direction: "incoming" }),
    );
    if (source) return source;
    if (/^csv\s*\(/i.test(this.text.slice(this.index))) throw new QueryError(t("csv() sources are not available: queries read only notes in the open folder."), ...this.position());
    return this.fail(t("source"));
  }
  position(): [number, number] { const before = this.text.slice(0, this.index).split("\n"); return [before.length, before.at(-1)!.length + 1]; }

  // Queries.
  header(): Header {
    const kind = this.need(/(TABLE|LIST|TASK|CALENDAR)/iy, "TABLE, LIST")[1].toUpperCase();
    if (kind === "TASK" || kind === "CALENDAR") throw new QueryError(t("{{kind}} queries are not supported. Use TABLE or LIST.", { kind }), 1, 1);
    if (this.eof()) return kind === "TABLE" ? { type: "table", fields: [], showId: true } : { type: "list", showId: true };
    this.ws1();
    const withoutId = !!this.attempt(() => { this.need(/WITHOUT\s+ID/iy, "WITHOUT ID"); this.ws(); return true; });
    if (kind === "TABLE") return { type: "table", fields: this.list(() => this.namedField()), showId: !withoutId };
    return { type: "list", format: this.attempt(() => this.field()) ?? undefined, showId: !withoutId };
  }
  clause(): Operation {
    const clause = this.first<Operation>(
      () => { this.need(/WHERE/iy, "WHERE"); this.ws1(); return { type: "where", clause: this.field() }; },
      () => {
        this.need(/SORT/iy, "SORT"); this.ws1();
        const sortField = (): SortField => {
          const field = this.field(); this.ws();
          const direction = this.eat(/(ASCENDING|DESCENDING|ASC|DESC)/iy)?.[1].toUpperCase();
          return { field, direction: direction?.startsWith("DESC") ? "descending" : "ascending" };
        };
        const fields = this.list(sortField);
        return fields.length ? { type: "sort", fields } : this.fail(t("expression"));
      },
      () => { this.need(/LIMIT/iy, "LIMIT"); this.ws1(); return { type: "limit", amount: this.field() }; },
      () => { this.need(/GROUP BY/iy, "GROUP BY"); this.ws1(); return { type: "group", field: this.namedField() }; },
      () => { this.need(/FLATTEN/iy, "FLATTEN"); this.ws1(); return { type: "flatten", field: this.namedField() }; },
    );
    return clause ?? this.fail("WHERE, SORT, LIMIT, GROUP BY, FLATTEN");
  }
  query(): Query {
    this.wsComments();
    const header = this.attempt(() => this.header()) ?? (() => { throw this.error(); })();
    this.wsComments();
    let source: Source = { type: "empty" };
    const from = this.attempt(() => { this.need(/FROM/iy, "FROM"); this.ws1(); return this.source(); });
    if (from) { source = from; this.wsComments(); }
    const operations: Operation[] = [];
    while (!this.eof()) {
      const operation = this.attempt(() => this.clause());
      if (!operation) throw this.error();
      operations.push(operation);
      this.wsComments();
    }
    return { header, source, operations };
  }
}

/** Parse `path#heading|display` link internals, honouring escaped pipes. */
export function parseInnerLink(raw: string): Link {
  const pipe = raw.search(/(?<!\\)\|/);
  if (pipe >= 0) return Link.infer(raw.slice(0, pipe).replace(/\\$/, "").trim(), false, raw.slice(pipe + 1).trim());
  return Link.infer(raw.trim());
}

/** Parse a full DQL query; throws QueryError with a localized message and position. */
export function parseQuery(text: string): Query {
  const parser = new Parser(text);
  return parser.query();
}

/** Parse a whole string as one expression, or null. Used for frontmatter typing. */
function whole<T>(text: string, rule: (parser: Parser) => T): T | null {
  const parser = new Parser(text);
  const value = parser.attempt(() => rule(parser));
  return value !== null && parser.eof() ? value : null;
}
export const parseDate = (text: string) => whole(text, parser => parser.date());
export const parseDatePlus = (text: string) => whole(text, parser => parser.datePlus());
export const parseDuration = (text: string) => whole(text, parser => parser.duration());
export const parseEmbedLink = (text: string) => whole(text, parser => parser.embedLink());
export const parseField = (text: string) => { const parser = new Parser(text); parser.ws(); const field = parser.attempt(() => parser.field()); parser.ws(); if (!field || !parser.eof()) throw parser.error(); return field; };
