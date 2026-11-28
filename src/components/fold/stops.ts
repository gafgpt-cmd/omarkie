import { t } from "../../i18n";

export const STOPS = ["full", "brief", "key", "takeaway", "topic"] as const;
export type Stop = typeof STOPS[number];
// Where Fold view opens: a source line, optionally at a viewport y with that line focused (the return from the editor).
export interface FoldStart { line: number; y?: number; focus?: boolean }

export function stopLabel(stop: Stop) {
  return stop === "full" ? t("Full") : stop === "brief" ? t("Brief") : stop === "key" ? t("Key") : stop === "takeaway" ? t("Takeaway") : t("Topic");
}
