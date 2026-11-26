import assert from "node:assert/strict";
import { test } from "node:test";
import { createClock, replayJournalText, visibleMagnets } from "../shared/glass-core.mjs";

// A realistic 2-device offline session for one note: both devices start from the same
// journal, one is offline for an hour, then their journals merge line by line (G2d).
const clock = (device, start) => {
  let wall = start;
  const value = createClock(device, () => wall);
  return { value, tick(step = 1_000) { wall += step; return value.next(); } };
};

const set = (magnetId, field, value, hlc, device) => JSON.stringify({ op: "set", magnetId, field, value, hlc, device });

function seed() {
  const a = clock("laptop", Date.UTC(2026, 10, 24, 9));
  return {
    initial: [
      set("m1", "kind", "sticky", a.tick(), "laptop"),
      set("m1", "text", "Retrieval practice from the new edition.", a.tick(), "laptop"),
      set("m1", "anchor", { version: 2, landmarks: [{ kind: "quote", value: { exact: "Retrieval practice", prefix: "", suffix: "" } }] }, a.tick(), "laptop"),
      set("m1", "x", 120, a.tick(), "laptop"),
      set("m1", "y", 240, a.tick(), "laptop"),
      set("m2", "kind", "sticky", a.tick(), "laptop"),
      set("m2", "text", "Delete me on the phone.", a.tick(), "laptop"),
    ],
    laptopClock: a,
  };
}

test("two offline devices converge without losing either edit", () => {
  const { initial, laptopClock: laptop } = seed();
  const phone = clock("phone", Date.UTC(2026, 10, 24, 10));
  // Laptop (offline): rewords the note and moves it on the page.
  const laptopLines = [
    ...initial,
    set("m1", "text", "Retrieval practice, spaced over days.", laptop.tick(), "laptop"),
    set("m1", "x", 300, laptop.tick(), "laptop"),
    set("m3", "kind", "sticker", laptop.tick(), "laptop"),
    set("m3", "name", "spaced repetition", laptop.tick(), "laptop"),
  ];
  // Phone (offline): deletes m2, colours m1, creates a different new magnet.
  const phoneLines = [
    ...initial,
    JSON.stringify({ op: "delete", magnetId: "m2", hlc: phone.tick(), device: "phone" }),
    set("m1", "colour", "rose", phone.tick(), "phone"),
    set("m4", "kind", "sticky", phone.tick(), "phone"),
    set("m4", "text", "Ask about interleaving.", phone.tick(), "phone"),
  ];

  const leftToRight = replayJournalText([...laptopLines, ...phoneLines].join("\n") + "\n");
  const rightToLeft = replayJournalText([...phoneLines, ...laptopLines].join("\n") + "\n");
  const one = Object.fromEntries(visibleMagnets(leftToRight.magnets).map(mark => [mark.id, mark.fields]));
  const two = Object.fromEntries(visibleMagnets(rightToLeft.magnets).map(mark => [mark.id, mark.fields]));
  assert.deepEqual(one, two, "merge order does not matter");
  assert.equal(one.m1.text, "Retrieval practice, spaced over days.", "the later wording wins");
  assert.equal(one.m1.colour, "rose", "the other device's colour survives");
  assert.equal(one.m1.x, 300, "the laptop move survives");
  assert.equal(one.m1.y, 240, "the untouched axis survives");
  assert.ok(one.m3?.name, "laptop's new magnet survives");
  assert.ok(one.m4?.text, "phone's new magnet survives");
  assert.equal(one.m2, undefined, "the phone's tombstone wins");
});

test("an older delete merged late cannot resurrect a restored magnet", () => {
  const { initial } = seed();
  const laptop = clock("laptop", Date.UTC(2026, 10, 24, 11));
  const older = JSON.stringify({ op: "delete", magnetId: "m2", hlc: "1-0", device: "phone" });
  const restored = JSON.stringify({ op: "restore", magnetId: "m2", hlc: laptop.tick(5_000), device: "laptop" });
  const replay = replayJournalText([...initial, restored, older].join("\n") + "\n");
  const m2 = visibleMagnets(replay.magnets).find(mark => mark.id === "m2");
  assert.ok(m2, "a newer restore beats an older delete no matter the line order");
});

test("duplicate journal lines from a retried merge stay idempotent", () => {
  const { initial } = seed();
  const replay = replayJournalText([...initial, ...initial, ...initial].join("\n") + "\n");
  assert.equal(visibleMagnets(replay.magnets).length, 2);
  assert.equal(replay.duplicates, initial.length * 2);
});
