// Dataview value model, ported from blacksmithgu/obsidian-dataview (MIT) src/data-model/value.ts.
// Provenance: third-party/obsidian-ports/NOTICE. Luxon is replaced by native Date in local time.

export type LinkType = "file" | "header" | "block";
export class Link {
  readonly path: string;
  readonly embed: boolean;
  readonly display?: string;
  readonly subpath?: string;
  readonly type: LinkType;
  constructor(path: string, embed = false, display?: string, subpath?: string, type: LinkType = "file") { this.path = path; this.embed = embed; this.display = display; this.subpath = subpath; this.type = type; }
  static infer(linkpath: string, embed = false, display?: string): Link {
    if (linkpath.includes("#^")) { const [path, block] = linkpath.split("#^"); return new Link(path, embed, display, block, "block"); }
    if (linkpath.includes("#")) { const [path, ...heading] = linkpath.split("#"); return new Link(path, embed, display, heading.join("#"), "header"); }
    return new Link(linkpath, embed, display);
  }
  withPath(path: string) { return new Link(path, this.embed, this.display, this.subpath, this.type); }
  withDisplay(display?: string) { return new Link(this.path, this.embed, display, this.subpath, this.type); }
  toFile() { return new Link(this.path, this.embed, this.display); }
  fileName() { return (this.path.split("/").at(-1) || this.path).replace(/\.(md|markdown|mdown)$/i, ""); }
  label() { return this.display || (this.subpath ? `${this.fileName()} > ${this.subpath}` : this.fileName()); }
  equals(other: Link) { return this.path === other.path && this.type === other.type && this.subpath === other.subpath; }
  /** Wiki-link text with a readable label, so concatenated strings still render as links. */
  markdown() { return `${this.embed ? "!" : ""}[[${this.path}${this.subpath ? (this.type === "block" ? "#^" : "#") + this.subpath : ""}|${this.label().replace(/[|\]]/g, " ")}]]`; }
}

/** A point in time; formatted in the user's local time zone like Dataview's default luxon zone. */
export class DvDate {
  readonly ms: number;
  constructor(ms: number) { this.ms = ms; }
  static local(year: number, month = 1, day = 1, hour = 0, minute = 0, second = 0, millisecond = 0) { return new DvDate(new Date(year, month - 1, day, hour, minute, second, millisecond).getTime()); }
  get date() { return new Date(this.ms); }
  get year() { return this.date.getFullYear(); }
  get month() { return this.date.getMonth() + 1; }
  get day() { return this.date.getDate(); }
  get hour() { return this.date.getHours(); }
  get minute() { return this.date.getMinutes(); }
  get second() { return this.date.getSeconds(); }
  get millisecond() { return this.date.getMilliseconds(); }
  /** ISO weekday: Monday 1 through Sunday 7. */
  get weekday() { return this.date.getDay() || 7; }
  get weekyear() { return isoWeek(this.date).week; }
  get dateOnly() { return this.hour === 0 && this.minute === 0 && this.second === 0 && this.millisecond === 0; }
  startOfDay() { return DvDate.local(this.year, this.month, this.day); }
  plus(duration: Duration, sign = 1) {
    const value = this.date, months = sign * duration.months, days = sign * duration.days;
    const wholeMonths = Math.trunc(months), wholeDays = Math.trunc(days);
    if (wholeMonths) {
      const day = value.getDate();
      value.setDate(1); value.setMonth(value.getMonth() + wholeMonths);
      value.setDate(Math.min(day, new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()));
    }
    if (wholeDays) value.setDate(value.getDate() + wholeDays);
    return new DvDate(value.getTime() + (months - wholeMonths) * 30 * DAY + (days - wholeDays) * DAY + sign * duration.ms);
  }
}

const DAY = 86_400_000;
function isoWeek(value: Date) {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return { week: Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY + 1) / 7) };
}

/** Calendar-aware duration; months and days stay calendar units, the rest is milliseconds. */
export class Duration {
  readonly months: number;
  readonly days: number;
  readonly ms: number;
  constructor(months = 0, days = 0, ms = 0) { this.months = months; this.days = days; this.ms = ms; }
  /** Casual conversion used for comparison and division, matching luxon: year 365 days, month 30 days. */
  toMillis() { const years = Math.trunc(this.months / 12); return years * 365 * DAY + (this.months - years * 12) * 30 * DAY + this.days * DAY + this.ms; }
  plus(other: Duration, sign = 1) { return new Duration(this.months + sign * other.months, this.days + sign * other.days, this.ms + sign * other.ms); }
  scale(factor: number) { return new Duration(this.months * factor, this.days * factor, this.ms * factor); }
  get years() { return this.months / 12; }
  get weeks() { return this.days / 7; }
  get hours() { return this.ms / 3_600_000; }
  get minutes() { return this.ms / 60_000; }
  get seconds() { return this.ms / 1000; }
  get milliseconds() { return this.ms; }
}

/** A query lambda; the evaluation context is passed through so nested calls share its budget. */
export type Callable = (context: object, ...args: Literal[]) => Literal;
export type Literal = null | boolean | number | string | DvDate | Duration | Link | Literal[] | Callable | { [key: string]: Literal };
export type LiteralType = "null" | "boolean" | "number" | "string" | "date" | "duration" | "link" | "array" | "function" | "object";

export function typeOf(value: Literal | undefined): LiteralType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Duration) return "duration";
  if (value instanceof DvDate) return "date";
  if (Array.isArray(value)) return "array";
  if (value instanceof Link) return "link";
  if (typeof value === "function") return "function";
  return "object";
}

export const isObject = (value: Literal): value is { [key: string]: Literal } => typeOf(value) === "object";

/** Dataview truthiness: empty text, zero, empty list or object, and null are false. */
export function isTruthy(value: Literal | undefined): boolean {
  switch (typeOf(value)) {
    case "number": return value !== 0;
    case "string": case "array": return (value as string | Literal[]).length > 0;
    case "boolean": return value as boolean;
    case "link": return !!(value as Link).path;
    case "date": return (value as DvDate).ms !== 0;
    case "duration": return (value as Duration).toMillis() !== 0;
    case "object": return Object.keys(value as object).length > 0;
    case "function": return true;
    default: return false;
  }
}

/** Total order across all values; nulls first, then values grouped by type name. */
export function compareValue(left: Literal | undefined, right: Literal | undefined, normalize: (link: Link) => string = link => link.path): number {
  if (left === undefined) left = null;
  if (right === undefined) right = null;
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const leftType = typeOf(left), rightType = typeOf(right);
  if (leftType !== rightType) return leftType.localeCompare(rightType);
  if (left === right) return 0;
  switch (leftType) {
    case "string": return (left as string).localeCompare(right as string);
    case "number": return (left as number) < (right as number) ? -1 : (left as number) === (right as number) ? 0 : 1;
    case "boolean": return left === right ? 0 : left ? 1 : -1;
    case "date": return Math.sign((left as DvDate).ms - (right as DvDate).ms);
    case "duration": return Math.sign((left as Duration).toMillis() - (right as Duration).toMillis());
    case "link": {
      const a = left as Link, b = right as Link;
      const path = normalize(a).localeCompare(normalize(b));
      if (path) return path;
      const display = (a.display ?? a.fileName()).localeCompare(b.display ?? b.fileName());
      return display || (a.subpath ?? "").localeCompare(b.subpath ?? "");
    }
    case "array": {
      const a = left as Literal[], b = right as Literal[];
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const result = compareValue(a[index], b[index], normalize);
        if (result) return result;
      }
      return a.length - b.length;
    }
    case "object": {
      const a = left as Record<string, Literal>, b = right as Record<string, Literal>;
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        if (!(key in a)) return -1;
        if (!(key in b)) return 1;
        const result = compareValue(a[key], b[key], normalize);
        if (result) return result;
      }
      return 0;
    }
    default: return 0;
  }
}

export const equalValue = (left: Literal, right: Literal) => compareValue(left, right) === 0;

const durationUnits: [string, (duration: Duration) => number][] = [
  ["year", value => Math.trunc(value.months / 12)], ["month", value => value.months - Math.trunc(value.months / 12) * 12],
  ["day", value => value.days], ["hour", value => Math.trunc(value.ms / 3_600_000)],
  ["minute", value => Math.trunc(value.ms % 3_600_000 / 60_000)], ["second", value => Math.round(value.ms % 60_000) / 1000],
];

/** Human text for any value, in the given UI locale. */
export function valueText(value: Literal | undefined, locale: string, nested = false): string {
  switch (typeOf(value)) {
    case "null": return "-";
    case "string": return value as string;
    case "number": return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value as number);
    case "boolean": return String(value);
    case "date": {
      const date = value as DvDate;
      return new Intl.DateTimeFormat(locale, date.dateOnly ? { dateStyle: "long" } : { dateStyle: "long", timeStyle: "short" }).format(date.date);
    }
    case "duration": return durationText(value as Duration, locale);
    case "link": return (value as Link).label();
    case "function": return "<function>";
    case "array": {
      const text = (value as Literal[]).map(item => valueText(item, locale, true)).join(", ");
      return nested ? `[${text}]` : text;
    }
    default: return "{ " + Object.entries(value as Record<string, Literal>).map(([key, item]) => `${key}: ${valueText(item, locale, true)}`).join(", ") + " }";
  }
}

export function durationText(duration: Duration, locale: string) {
  const parts = durationUnits.map(([unit, amount]) => [unit, amount(duration)] as const).filter(([, amount]) => amount !== 0)
    .map(([unit, amount]) => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 3 }).format(amount));
  return parts.length ? parts.join(", ") : new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "long" }).format(0);
}
