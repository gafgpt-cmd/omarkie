export declare const glassLayerIds: readonly ["ink", "notes", "media", "cards", "comments"];
export declare const glassLayerNames: Record<string, string>;
export declare const glassLayerDefaults: { readonly visible: true; readonly locked: false; readonly opacity: 100 };
export type GlassLayerId = (typeof glassLayerIds)[number];
export interface GlassLayerState { visible: boolean; locked: boolean; opacity: number }
export type GlassLayerStates = Record<GlassLayerId, GlassLayerState>;

export declare function glassLayerOf(kind: unknown): GlassLayerId | null;
export declare const studySheetLayers: Record<string, GlassLayerId>;
export declare function studySheetLayer(sheet: string): GlassLayerId;
export declare function validGlassLayer(value: unknown): value is GlassLayerId;
export declare function savedLayerField(saved: unknown, layer: string, name: string): unknown;
export declare function layerState(saved: unknown, layer: string): GlassLayerState;
export declare function layerStates(saved?: unknown): GlassLayerStates;
export declare function layerPatch(input: unknown): Partial<GlassLayerState>;
export declare function layerCounts(magnets: readonly { kind?: unknown; fields?: { kind?: unknown } }[]): Record<GlassLayerId, number>;
export declare function layerCreated(layer: string, state: GlassLayerState, count: number, studyCount?: number): boolean;
