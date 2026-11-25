import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService, arrowFields, stickerFields } from "../electron/glass-service.mjs";
import { indexBlocks, matchIndexed } from "../src/glass/anchor-map.ts";
import { arrowFromMagnet, arrowPath, edgePoint, headPath, jumpFor, midpoint, resolveArrowEnd, routeArrow, routeArrows } from "../src/glass/arrow-model.ts";
import { stickerFromMagnet } from "../src/glass/sticker-model.ts";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });
const anchor = (text, headings = ["Memory"], line = 3) => ({ landmarks: [{ kind: "block", block: text, headings, line }] });
const box = (x, y, width, height) => ({ x, y, width, height });
const arrow = (patch = {}) => ({ id: "m-arrow", from: { kind: "magnet", magnet: "m-a" }, to: { kind: "element", element: "paragraph-1", anchor: anchor("Mechanism paragraph") },
  style: "straight", color: "ink", head: "solid", label: "", ...patch });

test("a straight arrow leaves and enters on the box edges, not the centres", () => {
  const from = box(0, 0, 100, 40), to = box(400, 300, 120, 50);
  const route = routeArrow(arrow(), from, to);
  assert.equal(route.from.y, 40);
  assert.ok(route.from.x > 0 && route.from.x < 100, `leaves the bottom edge (${route.from.x})`);
  assert.equal(route.to.y, 300);
  assert.ok(route.to.x > 400 && route.to.x < 520, `enters the top edge (${route.to.x})`);
  assert.match(route.d, /^M .+ L /);
  assert.ok(route.head.endsWith("Z"), "solid head is a closed triangle");
  assert.deepEqual(route.label, { x: (route.from.x + route.to.x) / 2, y: (route.from.y + route.to.y) / 2 });
});

test("a curved arrow bends away from the straight line and keeps both edge ends", () => {
  const from = box(0, 0, 100, 40), to = box(400, 300, 120, 50);
  const straight = routeArrow(arrow(), from, to), curved = routeArrow(arrow({ style: "curved" }), from, to);
  assert.match(curved.d, / C /);
  assert.deepEqual(curved.from, straight.from);
  assert.deepEqual(curved.to, straight.to);
  assert.notDeepEqual(curved.label, straight.label);
  const bend = midpoint(curved.from, curved.to, "curved");
  assert.deepEqual(bend, curved.label);
});

test("head shapes: solid closes, open stays two strokes, none draws nothing", () => {
  const from = { x: 0, y: 0 }, to = { x: 100, y: 0 }, angle = 0, tip = { x: 102, y: 0 };
  const solid = headPath(tip, angle, "solid"), open = headPath(tip, angle, "open");
  assert.ok(solid.endsWith("Z") && !open.endsWith("Z"));
  assert.equal((open.match(/ L /g) ?? []).length, 2);
  assert.equal(headPath(tip, angle, "none"), "");
  assert.equal(arrowPath(from, to, "straight").angle, 0);
  assert.deepEqual(edgePoint(box(0, 0, 10, 10), { x: 100, y: 5 }), { x: 10, y: 5 });
});

test("a long arrow to an off-screen end becomes a jump chip at the visible end", () => {
  const view = { top: 0, height: 600 };
  const down = jumpFor(view, { from: { x: 100, y: 200 }, to: { x: 100, y: 2_400 } });
  assert.deepEqual(down?.far, "to");
  assert.equal(down?.direction, "down");
  assert.ok(down && down.point.y <= 600 && down.point.y > 0);
  const up = jumpFor({ top: 2_000, height: 600 }, { from: { x: 100, y: 300 }, to: { x: 100, y: 2_400 } });
  assert.deepEqual(up?.far, "from");
  assert.equal(up?.direction, "up");
  assert.equal(jumpFor(view, { from: { x: 0, y: 100 }, to: { x: 0, y: 500 } }), null, "both ends visible");
  assert.equal(jumpFor(view, { from: { x: 0, y: -900 }, to: { x: 0, y: 2_400 } }), null, "both ends hidden");
});

test("an arrow end follows its paragraph through an edit above it", () => {
  const original = [
    { block: "Drug doses", headings: ["Protocol"], line: 3, element: box(0, 0, 300, 40) },
    { block: "Mechanism paragraph", headings: ["Protocol"], line: 9, element: box(0, 400, 300, 40) },
  ];
  const shifted = [
    { block: "New opening line", headings: ["Protocol"], line: 1, element: box(0, 0, 300, 40) },
    { block: "Drug doses", headings: ["Protocol"], line: 5, element: box(0, 40, 300, 40) },
    { block: "Mechanism paragraph", headings: ["Protocol"], line: 11, element: box(0, 440, 300, 40) },
  ];
  const context = blocks => {
    const index = indexBlocks(blocks);
    return {
      line: value => matchIndexed(index, value),
      elementAt: (line) => blocks.find(block => block.line === line)?.element,
      magnet: id => id === "m-a" ? box(0, 120, 80, 80) : undefined,
    };
  };
  const before = resolveArrowEnd(arrow().to, context(original));
  const after = resolveArrowEnd(arrow().to, context(shifted));
  assert.equal(before?.y, 400);
  assert.equal(after?.y, 440, "the far end moved with its paragraph");
  const routes = routeArrows([arrow()], context(shifted));
  assert.deepEqual(routes.orphans, []);
  assert.equal(routes.routes[0].to.y, 440);
});

test("300 arrows re-route inside one frame", () => {
  const blocks = Array.from({ length: 60 }, (_, index) => ({ block: `Paragraph ${index}`, headings: ["Protocol"], line: index + 1,
    element: box(0, index * 90, 520, 60) }));
  const index = indexBlocks(blocks);
  const context = { line: value => matchIndexed(index, value), elementAt: line => blocks.find(block => block.line === line)?.element,
    magnet: () => undefined };
  const many = Array.from({ length: 300 }, (_, value) => arrow({ id: `m-${value}`,
    from: { kind: "element", element: `paragraph-${value % 60}`, anchor: anchor(`Paragraph ${value % 60}`) },
    to: { kind: "element", element: `paragraph-${(value * 7) % 60}`, anchor: anchor(`Paragraph ${(value * 7) % 60}`) } }));
  for (let warm = 0; warm < 3; warm++) routeArrows(many, context);
  const times = [];
  let routes;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    routes = routeArrows(many, context);
    times.push(performance.now() - started);
  }
  const best = Math.min(...times);
  assert.equal(routes.routes.length, 300);
  assert.ok(best < 16, `300 arrows route in ${best.toFixed(2)} ms (${times.map(value => value.toFixed(1)).join("/")})`);
});

test("a deleted paragraph turns its arrow into an orphan, never a crash", () => {
  const blocks = [{ block: "Other paragraph", headings: ["Protocol"], line: 3, element: box(0, 0, 300, 40) }];
  const index = indexBlocks(blocks);
  const routes = routeArrows([arrow()], { line: anchor => matchIndexed(index, anchor), elementAt: line => blocks.find(block => block.line === line)?.element,
    magnet: () => box(0, 120, 80, 80) });
  assert.deepEqual(routes.orphans, ["m-arrow"]);
  assert.deepEqual(routes.routes, []);
});

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-glass-marks-"));
  scratch.push(root);
  const data = path.join(root, "app-data"), folder = path.join(root, "vault");
  await mkdir(folder, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, "map.md"), "# Map\n\nContour lines close together mean a steep slope.\n\nA saddle is a low point between two summits.\n");
  const service = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
  return { root, folder, data, service };
}

test("a sticker keeps its sheet, box, rotation and notes layer through the journal", async () => {
  const { service, folder, data } = await vault();
  try {
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-star", fields: stickerFields({
      kind: "sticker", sticker: "star", anchor: anchor("Contour lines close together mean a steep slope."), x: 12, y: -8, w: 72, h: 72, rotate: 0 }) });
    assert.equal(added.magnet.fields.kind, "sticker");
    assert.equal(added.magnet.fields.layer, "notes");
    assert.equal(added.magnet.fields.rotate, 0);
    const turned = await service.request({ action: "set", note: "map.md", magnet: "m-star", fields: { rotate: -45, x: 24, w: 96, h: 96 } });
    assert.equal(turned.magnet.fields.rotate, -45);
    assert.equal(turned.magnet.fields.sticker, "star");
    await service.close();
    const reopened = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
    try {
      const listed = await reopened.request({ action: "list", note: "map.md" });
      assert.deepEqual(listed.magnets.map(item => stickerFromMagnet(item)), [{ id: "m-star", sticker: "star",
        anchor: anchor("Contour lines close together mean a steep slope."), x: 24, y: -8, w: 96, h: 96, rotate: -45 }]);
    } finally { await reopened.close(); }
  } finally { await service.close().catch(() => {}); }
});

test("stickers validate the sheet id, the custom image and the layer", async () => {
  const { service } = await vault();
  try {
    const base = { kind: "sticker", sticker: "check", anchor: anchor("A saddle is a low point between two summits.") };
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...base, sticker: "unicorn" } }), /Sticker must be one of/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...base, layer: "media" } }), /notes layer/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...base, x: 1e9 } }), /Sticker x must be a number/);
    const custom = "data:image/png;base64,iVBORw0KGgo=";
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...base, image: custom } }), /either built-in or custom/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "sticker", anchor: base.anchor, image: "https://example.com/a.png" } }), /data URL image/);
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-custom", fields: { kind: "sticker", image: custom, anchor: base.anchor } });
    assert.equal(added.magnet.fields.image, custom);
    assert.equal(added.magnet.fields.sticker, undefined);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-custom", fields: { kind: "sticky" } }), /keeps its kind/);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-custom", fields: { rotate: 400 } }), /rotate/);
    assert.throws(() => stickerFields({ kind: "sticker", sticker: "star", image: custom, anchor: base.anchor }, false), /either built-in or custom/);
  } finally { await service.close(); }
});

test("an arrow stores both anchored ends and updates style, head and label", async () => {
  const { service } = await vault();
  try {
    const from = { kind: "element", element: "paragraph-abc", anchor: anchor("Contour lines close together mean a steep slope.") };
    const to = { kind: "magnet", magnet: "m-star" };
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-arrow", fields: arrowFields({ kind: "arrow", from, to, style: "curved", color: "red", head: "solid", label: "" }, false) });
    assert.equal(added.magnet.fields.kind, "arrow");
    assert.equal(added.magnet.fields.style, "curved");
    assert.equal(added.magnet.fields.color, "red");
    assert.deepEqual(added.magnet.fields.from, from);
    const edited = await service.request({ action: "set", note: "map.md", magnet: "m-arrow", fields: { label: "dose → mechanism", head: "open" } });
    assert.equal(edited.magnet.fields.label, "dose → mechanism");
    assert.equal(edited.magnet.fields.head, "open");
    const read = await service.request({ action: "show", note: "map.md", magnet: "m-arrow" });
    assert.deepEqual(arrowFromMagnet(read.magnet), { id: "m-arrow", from, to, style: "curved", color: "red", head: "open", label: "dose → mechanism" });
    assert.deepEqual(arrowFromMagnet({ id: "m-broken", kind: "arrow", fields: { ...read.magnet.fields, to: { kind: "magnet", magnet: "bad id!" } } }), undefined);
  } finally { await service.close(); }
});

test("arrows reject a self link, an unanchored element end and unknown fields", async () => {
  const { service } = await vault();
  try {
    const end = { kind: "magnet", magnet: "m-one" };
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "arrow", from: end, to: end } }), /two different ends/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "arrow", from: { kind: "element", element: "p-1", anchor: { landmarks: [] } }, to: end } }), /from must be an element/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "arrow", from: end, to: { kind: "magnet", magnet: "m-two" }, style: "zigzag" } }), /style must be one of/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "arrow", from: end, to: { kind: "magnet", magnet: "m-two" }, colour: "red" } }), /Unknown arrow field/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "arrow", from: end, to: { kind: "magnet", magnet: "m-two" }, label: "x".repeat(241) } }), /label must be text/);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-missing", fields: { label: "x" } }), /not found/);
  } finally { await service.close(); }
});
