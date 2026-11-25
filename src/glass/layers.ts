import { useSyncExternalStore } from "react";
import {
  glassLayerDefaults, glassLayerIds, validGlassLayer, type GlassLayerId, type GlassLayerState, type GlassLayerStates,
} from "../../shared/glass-layers.mjs";

// One small store for the five shared layers. The panel writes, GlassLayer reads through CSS variables,
// so a toggle over 500 magnets repaints without re-rendering any magnet.
export interface GlassLayerSnapshot { note: string | null; layers: GlassLayerStates; counts: Record<string, number> }

const empty = (): GlassLayerStates => Object.fromEntries(glassLayerIds.map(id => [id, { ...glassLayerDefaults }])) as GlassLayerStates;
const inertLayers: Partial<Record<GlassLayerId, boolean>> = {};
const noCounts = (): Record<string, number> => Object.fromEntries(glassLayerIds.map(id => [id, 0]));

let snapshot: GlassLayerSnapshot = { note: null, layers: empty(), counts: noCounts() };
const listeners = new Set<() => void>();

function stateOf(value: Partial<GlassLayerState> | undefined): GlassLayerState {
  const visible = typeof value?.visible === "boolean" ? value.visible : glassLayerDefaults.visible;
  const locked = typeof value?.locked === "boolean" ? value.locked : glassLayerDefaults.locked;
  const opacity = typeof value?.opacity === "number" && Number.isFinite(value.opacity)
    ? Math.min(100, Math.max(0, Math.round(value.opacity))) : glassLayerDefaults.opacity;
  return { visible, locked, opacity };
}

function apply(layers: GlassLayerStates) {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const id of glassLayerIds) {
    const layer = layers[id];
    style.setProperty(`--glass-layer-${id}-opacity`, String(layer.opacity / 100));
    style.setProperty(`--glass-layer-${id}-visibility`, layer.visible ? "visible" : "hidden");
    // Hidden layers already drop pointer events through visibility; only locks need inert.
    // Touch the DOM per node only when a layer's lock changes, so an eye toggle over 500 magnets is one style write.
    if (inertLayers[id] !== layer.locked) {
      for (const node of document.querySelectorAll(`[data-glass-layer="${id}"]`)) node.toggleAttribute("inert", layer.locked);
      inertLayers[id] = layer.locked;
    }
  }
  watchAdded();
}

// Agent writes and undo can mount a magnet after a layer was locked; tag it on arrival.
let observer: MutationObserver | undefined;
function watchAdded() {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      const marks = node.matches("[data-glass-layer]") ? [node, ...node.querySelectorAll("[data-glass-layer]")] : [...node.querySelectorAll("[data-glass-layer]")];
      for (const mark of marks) {
        const id = mark.getAttribute("data-glass-layer");
        const layer = validGlassLayer(id) ? snapshot.layers[id] : undefined;
        mark.toggleAttribute("inert", !!layer?.locked);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function commit(next: GlassLayerSnapshot) {
  snapshot = next;
  apply(next.layers);
  for (const listener of listeners) listener();
}

export function publishGlassLayers(note: string | null, layers: Partial<Record<GlassLayerId, Partial<GlassLayerState>>> | undefined,
  counts?: Record<string, number>) {
  const merged = empty();
  for (const id of glassLayerIds) merged[id] = stateOf(layers?.[id]);
  const totals = noCounts();
  if (counts) for (const id of glassLayerIds) totals[id] = Math.max(0, Math.round(Number(counts[id]) || 0));
  commit({ note, layers: merged, counts: totals });
}

export function patchGlassLayer(layer: GlassLayerId, patch: Partial<GlassLayerState>) {
  commit({ ...snapshot, layers: { ...snapshot.layers, [layer]: stateOf({ ...snapshot.layers[layer], ...patch }) } });
}

export function forgetGlassLayers() {
  commit({ note: null, layers: empty(), counts: noCounts() });
}

export const subscribeGlassLayers = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const readGlassLayers = () => snapshot;

export function useGlassLayers(note: string | null | undefined): GlassLayerStates {
  const current = useSyncExternalStore(subscribeGlassLayers, readGlassLayers, readGlassLayers);
  return current.note === (note ?? null) ? current.layers : empty();
}

export function useGlassLayerCounts(note: string | null | undefined): Record<string, number> {
  const current = useSyncExternalStore(subscribeGlassLayers, readGlassLayers, readGlassLayers);
  return current.note === (note ?? null) ? current.counts : noCounts();
}
