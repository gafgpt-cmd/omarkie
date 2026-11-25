// Glass layers: five shared shelves every magnet joins by kind.
// Layers are made on first use and exist to be shown, hidden, locked or dimmed; never one per element.

export const glassLayerIds = ["ink", "notes", "media", "cards", "comments"];

export const glassLayerNames = {
  ink: "Ink",
  notes: "Notes & stickers",
  media: "Media",
  cards: "AI cards",
  comments: "Comments",
};

export const glassLayerDefaults = { visible: true, locked: false, opacity: 100 };

// One magnet kind belongs to exactly one layer, decided here for the renderer, storage and omarkie-axi.
const kindLayers = {
  ink: "ink",
  sticky: "notes",
  sticker: "notes",
  arrow: "notes",
  image: "media",
  card: "cards",
  comment: "comments",
};

export function glassLayerOf(kind) {
  return Object.hasOwn(kindLayers, kind) ? kindLayers[kind] : null;
}

// Learning-mode study sheets are content filters, not glass layers; each maps to the layer it draws on,
// so hiding a glass layer also hides the study marks that live there.
export const studySheetLayers = {
  notes: "notes",
  doubts: "notes",
  highlights: "ink",
  images: "media",
  "tutor-answers": "cards",
  proposals: "cards",
  exam: "cards",
  glossary: "cards",
};

export function studySheetLayer(sheet) {
  return Object.hasOwn(studySheetLayers, sheet) ? studySheetLayers[sheet] : "notes";
}

export function validGlassLayer(value) {
  return typeof value === "string" && glassLayerIds.includes(value);
}

// A saved journal keeps one entry per layer field; replay hands it back as a Map of Maps.
export function savedLayerField(saved, layer, name) {
  const holder = saved instanceof Map ? saved.get(layer) : saved?.[layer];
  return (holder instanceof Map ? holder.get(name) : holder?.[name])?.value;
}

const number = value => typeof value === "number" && Number.isFinite(value);

export function layerState(saved, layer) {
  const visible = savedLayerField(saved, layer, "visible");
  const locked = savedLayerField(saved, layer, "locked");
  const opacity = savedLayerField(saved, layer, "opacity");
  return {
    visible: typeof visible === "boolean" ? visible : glassLayerDefaults.visible,
    locked: typeof locked === "boolean" ? locked : glassLayerDefaults.locked,
    opacity: number(opacity) ? Math.min(100, Math.max(0, Math.round(opacity))) : glassLayerDefaults.opacity,
  };
}

export function layerStates(saved) {
  const states = {};
  for (const layer of glassLayerIds) states[layer] = layerState(saved, layer);
  return states;
}

export function layerPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A layer change needs an object.");
  const patch = {};
  if (input.visible !== undefined) {
    if (typeof input.visible !== "boolean") throw new Error("Layer visible must be true or false.");
    patch.visible = input.visible;
  }
  if (input.locked !== undefined) {
    if (typeof input.locked !== "boolean") throw new Error("Layer locked must be true or false.");
    patch.locked = input.locked;
  }
  if (input.opacity !== undefined) {
    const value = Number(input.opacity);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Layer opacity must be a number between 0 and 100.");
    patch.opacity = Math.round(value);
  }
  if (!Object.keys(patch).length) throw new Error("Supply a layer change: visible, locked or opacity.");
  return patch;
}

// Counts decide which layers exist for a note: a layer appears when its first magnet lands.
export function layerCounts(magnets) {
  const counts = {};
  for (const layer of glassLayerIds) counts[layer] = 0;
  for (const magnet of magnets ?? []) {
    const layer = glassLayerOf(magnet?.kind ?? magnet?.fields?.kind);
    if (layer) counts[layer] += 1;
  }
  return counts;
}

// The panel keeps a layer visible while it holds magnets or Learning content, or when a person changed it.
export function layerCreated(layer, state, count, studyCount = 0) {
  if (!validGlassLayer(layer)) return false;
  if (count > 0 || studyCount > 0) return true;
  return state.visible !== glassLayerDefaults.visible || state.locked !== glassLayerDefaults.locked || state.opacity !== glassLayerDefaults.opacity;
}
