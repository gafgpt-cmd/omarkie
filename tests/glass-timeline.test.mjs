import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeCue, displayTime, formatTime, keptDuration, parseTime, pinPercent, sourceTime,
  timelineFromMagnet, timestampFromMagnet, transcriptLine,
} from "../src/glass/timeline-model.ts";

test("clock text parses without locale and formats back", () => {
  assert.equal(parseTime("00:12"), 12);
  assert.equal(parseTime("1:02:03.5"), 3723.5);
  assert.equal(parseTime("90:00"), 5400);
  assert.equal(parseTime("12"), null);
  assert.equal(formatTime(12), "00:12");
  assert.equal(formatTime(3723.5), "1:02:03.5");
});

test("trims keep source time immutable while the display clock shrinks", () => {
  const trims = [{ from: 60, to: 120 }, { from: 300, to: 330 }];
  assert.equal(displayTime(30, trims), 30);
  assert.equal(displayTime(90, trims), 60, "inside a cut clamps to its start");
  assert.equal(displayTime(150, trims), 90);
  assert.equal(displayTime(400, trims), 310);
  assert.equal(sourceTime(90, trims), 150);
  assert.equal(sourceTime(310, trims), 400);
  assert.equal(keptDuration(600, trims), 510);
  assert.equal(pinPercent(400, 600, trims), 310 / 510);
});

test("timestamp magnets survive the journal and reject bad times", () => {
  const mark = timestampFromMagnet({ id: "t1", fields: { kind: "timestamp", timeline: "l1", t: 92.5, label: "Turn" } });
  assert.deepEqual(mark, { id: "t1", kind: "timestamp", timeline: "l1", t: 92.5, label: "Turn" });
  assert.equal(timestampFromMagnet({ id: "t2", fields: { kind: "timestamp", timeline: "l1", t: -1 } }), undefined);
  const timeline = timelineFromMagnet({ id: "l1", fields: { kind: "timeline", src: "lecture.mp3", duration: 600, trims: [{ from: 60, to: 120 }] } });
  assert.equal(timeline?.media, "audio");
  assert.deepEqual(timeline?.trims, [{ from: 60, to: 120 }]);
  assert.equal(timelineFromMagnet({ id: "l2", fields: { kind: "timeline", src: "clip.mp4" } })?.media, "video");
});

test("transcript paragraphs link both ways with playback time", () => {
  const cues = [
    transcriptLine("[00:10] First idea"),
    transcriptLine("1:00:05 - Later idea"),
    transcriptLine("not a transcript line"),
  ].filter(Boolean);
  assert.deepEqual(cues.map(cue => cue.start), [10, 3605]);
  assert.equal(activeCue(cues, 9), -1);
  assert.equal(activeCue(cues, 10), 0);
  assert.equal(activeCue(cues, 3599), 0);
  assert.equal(activeCue(cues, 3605.2), 1);
});
