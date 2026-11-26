import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTime, parseTime, pinPercent, timelineFromMagnet, timestampFromMagnet, transcriptLine,
} from "../src/glass/timeline-model.ts";

test("clock text parses without locale and formats back", () => {
  assert.equal(parseTime("00:12"), 12);
  assert.equal(parseTime("1:02:03.5"), 3723.5);
  assert.equal(parseTime("90:00"), 5400);
  assert.equal(parseTime("12"), null);
  assert.equal(formatTime(12), "00:12");
  assert.equal(formatTime(3723.5), "1:02:03.5");
});

test("pin geometry stays in source seconds", () => {
  assert.equal(pinPercent(300, 600), 0.5);
  assert.equal(pinPercent(-5, 600), 0);
  assert.equal(pinPercent(900, 600), 1);
  assert.equal(pinPercent(30, 0), 0);
});

test("timestamp magnets survive the journal and reject bad times", () => {
  const mark = timestampFromMagnet({ id: "t1", fields: { kind: "timestamp", timeline: "l1", t: 92.5, label: "Turn" } });
  assert.deepEqual(mark, { id: "t1", kind: "timestamp", timeline: "l1", t: 92.5, label: "Turn" });
  assert.equal(timestampFromMagnet({ id: "t2", fields: { kind: "timestamp", timeline: "l1", t: -1 } }), undefined);
  const timeline = timelineFromMagnet({ id: "l1", fields: { kind: "timeline", src: "lecture.mp3", duration: 600 } });
  assert.equal(timeline?.media, "audio");
  assert.equal(timelineFromMagnet({ id: "l2", fields: { kind: "timeline", src: "clip.mp4" } })?.media, "video");
});

test("transcript paragraphs parse without locale", () => {
  const cues = [
    transcriptLine("[00:10] First idea"),
    transcriptLine("1:00:05 - Later idea"),
    transcriptLine("not a transcript line"),
  ].filter(Boolean);
  assert.deepEqual(cues.map(cue => cue.start), [10, 3605]);
});
