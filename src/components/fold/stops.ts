import { t } from "../../i18n";

export const STOPS = ["full", "brief", "key", "takeaway", "topic"] as const;
export type Stop = typeof STOPS[number];

export function stopLabel(stop: Stop) {
  return stop === "full" ? t("Full") : stop === "brief" ? t("Brief") : stop === "key" ? t("Key") : stop === "takeaway" ? t("Takeaway") : t("Topic");
}
