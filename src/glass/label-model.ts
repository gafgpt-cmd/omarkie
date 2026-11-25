import { labelDefaults, labelFields, labelPoint, type LabelTarget } from "../../shared/glass-labels.mjs";
import { anchorFrom } from "./glass-state";
import type { GlassMagnet } from "./glass-model";

export type { LabelTarget };
export const labelLimits = labelDefaults;

export interface GlassLabel {
  id: string;
  target: LabelTarget;
  text: string;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  hidden: boolean;
  marked: boolean;
}

const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function targetOf(value: unknown): LabelTarget | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "magnet" && typeof record.magnet === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(record.magnet))
    return { kind: "magnet", magnet: record.magnet };
  if (record.kind === "element" && typeof record.element === "string") {
    const anchor = anchorFrom(record.anchor);
    if (anchor) return { kind: "element", element: record.element, anchor };
  }
  return;
}

export function labelFromMagnet(magnet: GlassMagnet): GlassLabel | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "label") return;
  const target = targetOf(fields.target);
  if (!target) return;
  return {
    id: magnet.id, target, text: text(fields.text, labelDefaults.textLimit),
    nx: number(fields.nx, 0.5, 0, 1), ny: number(fields.ny, 0.5, 0, 1),
    dx: number(fields.dx, 18, -labelDefaults.offsetLimit, labelDefaults.offsetLimit),
    dy: number(fields.dy, -14, -labelDefaults.offsetLimit, labelDefaults.offsetLimit),
    hidden: fields.hidden === true, marked: fields.marked === true,
  };
}

export function labelFieldsOf(label: GlassLabel): Record<string, unknown> {
  const values = { kind: "label", target: label.target, text: label.text, nx: label.nx, ny: label.ny, dx: label.dx, dy: label.dy,
    hidden: label.hidden, marked: label.marked };
  return labelFields(values);
}

export function newLabelId() {
  return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export { labelPoint };

export function labelCue(index: number) {
  return `Name ${index + 1}`;
}
