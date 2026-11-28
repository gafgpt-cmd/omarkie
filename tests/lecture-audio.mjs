import { writeFile } from "node:fs/promises";
import { encodeVoiceWav } from "../shared/voice.mjs";

// Synthetic "speech" for Chromium's fake microphone (--use-file-for-fake-audio-capture, which loops the file):
// voiced bursts of a 180 Hz harmonic stack with 5 ms ramps over a faint noise floor. No real voice, ever.
export async function speechWav(file, bursts, seconds, rate = 48_000) {
  const samples = new Float32Array(Math.round(rate * seconds)), ramp = rate * 0.005;
  let seed = 11;
  for (let index = 0; index < samples.length; index += 1) { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; samples[index] = (seed / 2 ** 31 - 0.5) * 0.002; }
  for (const [fromMs, toMs] of bursts) {
    const from = Math.round(fromMs * rate / 1000), to = Math.round(toMs * rate / 1000);
    for (let index = from; index < to; index += 1) {
      const envelope = Math.min(1, (index - from) / ramp, (to - index) / ramp), phase = 2 * Math.PI * 180 * index / rate;
      samples[index] += envelope * (0.22 * Math.sin(phase) + 0.12 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase));
    }
  }
  await writeFile(file, encodeVoiceWav(samples, rate));
}

// Onsets (ms) of the bursts in decoded mono samples: the first 10 ms window above `level` after 300 ms below it.
export function burstOnsets(samples, rate, level = 0.05) {
  const window = Math.round(rate / 100), onsets = [];
  let quiet = 30;
  for (let at = 0; at + window <= samples.length; at += window) {
    let sum = 0;
    for (let index = at; index < at + window; index += 1) sum += samples[index] * samples[index];
    if (Math.sqrt(sum / window) > level) { if (quiet >= 30) onsets.push(at * 1000 / rate); quiet = 0; }
    else quiet += 1;
  }
  return onsets;
}
