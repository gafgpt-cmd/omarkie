import assert from "node:assert/strict";
import { test } from "node:test";
import {
  glassLayerDefaults, glassLayerIds, glassLayerOf, glassLayerNames, layerCounts, layerCreated, layerPatch,
  layerState, layerStates, studySheetLayer, validGlassLayer,
} from "../shared/glass-layers.mjs";

test("every magnet kind joins one of five shared layers, never its own", () => {
  assert.deepEqual([...glassLayerIds], ["ink", "notes", "media", "cards", "comments"]);
  assert.equal(new Set(glassLayerIds.map(id => glassLayerNames[id])).size, 5);
  assert.equal(glassLayerOf("ink"), "ink");
  assert.equal(glassLayerOf("sticky"), "notes");
  assert.equal(glassLayerOf("sticker"), "notes");
  assert.equal(glassLayerOf("arrow"), "notes");
  assert.equal(glassLayerOf("image"), "media");
  assert.equal(glassLayerOf("card"), "cards");
  assert.equal(glassLayerOf("comment"), "comments");
  assert.equal(glassLayerOf("mystery"), null);
  assert.equal(validGlassLayer("notes"), true);
  assert.equal(validGlassLayer("element-42"), false);
});

test("counts add up per layer and a layer is created on first use", () => {
  const counts = layerCounts([{ kind: "sticky" }, { kind: "image" }, { kind: "sticker" }, { fields: { kind: "card" } }, { kind: "sticker" }]);
  assert.deepEqual(counts, { ink: 0, notes: 3, media: 1, cards: 1, comments: 0 });
  assert.equal(layerCreated("media", glassLayerDefaults, 1), true);
  assert.equal(layerCreated("media", glassLayerDefaults, 0), false);
  assert.equal(layerCreated("comments", glassLayerDefaults, 0, 2), true);
  assert.equal(layerCreated("ink", { visible: true, locked: false, opacity: 60 }, 0), true);
  assert.equal(layerCreated("ink", { visible: false, locked: false, opacity: 100 }, 0), true);
  assert.equal(layerCreated("element-42", glassLayerDefaults, 5), false);
});

test("study sheets keep their content filters but draw on one of the five layers", () => {
  assert.equal(studySheetLayer("highlights"), "ink");
  assert.equal(studySheetLayer("images"), "media");
  assert.equal(studySheetLayer("notes"), "notes");
  assert.equal(studySheetLayer("doubts"), "notes");
  assert.equal(studySheetLayer("tutor-answers"), "cards");
  assert.equal(studySheetLayer("proposals"), "cards");
  assert.equal(studySheetLayer("unknown"), "notes");
});

test("existing study sheets migrate into the shared layers without loss", () => {
  const sheets = ["notes", "doubts", "highlights", "images", "tutor-answers", "proposals", "exam", "glossary"];
  for (const sheet of sheets) {
    const layer = studySheetLayer(sheet);
    assert.equal(validGlassLayer(layer), true);
    // A sheet that already holds content makes its target layer exist even before any magnet lands.
    assert.equal(layerCreated(layer, glassLayerDefaults, 0, 1), true);
  }
  assert.equal(layerCounts([{ kind: "sticky" }]).notes, 1);
});

test("layer patches accept only the three controls with sane values", () => {
  assert.deepEqual(layerPatch({ visible: false }), { visible: false });
  assert.deepEqual(layerPatch({ locked: true, opacity: 42.6 }), { locked: true, opacity: 43 });
  assert.throws(() => layerPatch({}), /Supply a layer change/);
  assert.throws(() => layerPatch({ visible: "yes" }), /true or false/);
  assert.throws(() => layerPatch({ opacity: 101 }), /between 0 and 100/);
  assert.throws(() => layerPatch({ opacity: "half" }), /between 0 and 100/);
});

test("saved fields decode to defaults and clamp opacity", () => {
  const saved = new Map([
    ["notes", new Map([["visible", { value: false }], ["locked", { value: true }], ["opacity", { value: 150 }]])],
    ["media", new Map([["opacity", { value: "x" }]])],
  ]);
  assert.deepEqual(layerState(saved, "notes"), { visible: false, locked: true, opacity: 100 });
  assert.deepEqual(layerState(saved, "media"), { ...glassLayerDefaults });
  assert.deepEqual(layerStates(saved).ink, { ...glassLayerDefaults });
});
