import type { Agent, Slot } from "./fold-format.mjs";

export type SlotRoute = "local" | "agent" | "payload";
export type EgressKind = "none" | "loopback" | "remote";
export type FoldRouteCode = "FOLD_ROUTE_LOCAL" | "FOLD_OFFLINE" | "FOLD_MODEL_UNSET" | "FOLD_PAYLOAD_UNSET" | "FOLD_EGRESS_UNCONFIRMED";

export interface FoldSlotSetting {
  route: SlotRoute;
  agent: Agent;
  agentModel: string;
  /** Empty: the model set in the Payload preferences. */
  payloadModel: string;
  /** The destination the user allowed this slot to send note text to (`agent:<name>` or an origin). */
  allow: string | null;
}
export type FoldSlots = Record<Slot, FoldSlotSetting>;

export interface FoldEgress { kind: EgressKind; destination: string | null }

export interface FoldRoutePreferences {
  foldSlots?: unknown;
  payloadEnabled?: boolean;
  payloadBaseUrl?: string;
  payloadModel?: string;
  payloadAllowedOrigins?: string[];
  payloadModernLimit?: boolean;
}

export interface FoldPayloadConnection { baseUrl: string; origin: string; local: boolean; modernLimit: boolean; neverOnline?: boolean }

export interface FoldRouteDecision {
  slot: Slot;
  route: SlotRoute;
  agent?: Agent;
  model?: string;
  egress: FoldEgress;
  ready: boolean;
  code: FoldRouteCode | null;
  connection?: FoldPayloadConnection;
}

export declare const SLOT_ROUTES: readonly SlotRoute[];
export declare function defaultFoldSlots(): FoldSlots;
export declare function foldSlotsFrom(value: unknown): FoldSlots;
export declare function foldPayloadConnection(preferences: FoldRoutePreferences | null | undefined): Omit<FoldPayloadConnection, "neverOnline"> | null;
export declare function foldEgress(setting: FoldSlotSetting, preferences: FoldRoutePreferences | null | undefined): FoldEgress;
export declare function foldRoute(options: { slot: Slot; preferences: FoldRoutePreferences | null | undefined; neverOnline?: boolean }): FoldRouteDecision;
