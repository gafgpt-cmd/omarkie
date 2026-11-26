// G21: speech-to-text orchestration around the local hook. The renderer sends a canonical WAV;
// this module owns the temporary file and the keep-audio-on-failure rule.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanTranscript, validVoiceLanguage, validVoiceMode, validVoiceWav, voiceDefaults } from "../shared/voice.mjs";
import { keepAudio, runStt, sttArgv, sttConfigured, sttFailures } from "./stt.mjs";

export class Voice {
  constructor({ dataDir, environment = process.env }) {
    this.dataDir = dataDir;
    this.environment = environment;
  }

  info() {
    const configured = sttConfigured(this.environment);
    return {
      configured,
      valid: configured ? !!sttArgv(this.environment.OMARKIE_STT) : false,
      key: (this.environment.OMARKIE_STT_KEY || voiceDefaults.defaultKey).trim(),
      language: validVoiceLanguage(this.environment.OMARKIE_STT_LANG) ? this.environment.OMARKIE_STT_LANG : "auto",
      maxSeconds: voiceDefaults.maxSeconds,
    };
  }

  async transcribe({ wavBase64, mode = "dictation", language, signal }) {
    if (!sttConfigured(this.environment)) return { ok: false, code: "config", text: null, message: sttFailures.config };
    const argv = sttArgv(this.environment.OMARKIE_STT);
    if (!argv) return { ok: false, code: "config", text: null, message: sttFailures.config };
    if (typeof wavBase64 !== "string" || !wavBase64) return { ok: false, code: "bad-audio", text: null, message: sttFailures["bad-audio"] };
    const bytes = Buffer.from(wavBase64, "base64");
    if (bytes.length > voiceDefaults.wavBytes) return { ok: false, code: "bad-audio", text: null, message: sttFailures["bad-audio"] };
    if (!validVoiceWav(bytes)) return { ok: false, code: "bad-audio", text: null, message: sttFailures["bad-audio"] };
    const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-voice-"));
    const audio = path.join(scratch, "utterance.wav");
    try {
      await writeFile(audio, bytes, { mode: 0o600 });
      const result = await runStt({
        argv, audio, mode: validVoiceMode(mode) ? mode : "dictation",
        language: validVoiceLanguage(language) ? language : "auto",
        environment: this.environment, signal,
      });
      if (result.ok) return { ...result, text: cleanTranscript(result.text) };
      // A cancel is the person discarding the utterance; only real failures stay recoverable.
      const kept = result.code === "cancelled" ? null : await keepAudio(audio, path.join(this.dataDir, "voice-failed")).catch(() => null);
      return { ...result, kept };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  // omarkie-axi path: one existing WAV file, no renderer and no temporary copy.
  async transcribeFile(file, { mode = "dictation", language } = {}) {
    if (!sttConfigured(this.environment)) return { ok: false, code: "config", text: null, message: sttFailures.config };
    const argv = sttArgv(this.environment.OMARKIE_STT);
    if (!argv) return { ok: false, code: "config", text: null, message: sttFailures.config };
    const bytes = await readFile(file).catch(() => null);
    if (!bytes?.length) return { ok: false, code: "bad-audio", text: null, message: "Audio file not found." };
    if (!validVoiceWav(bytes)) return { ok: false, code: "bad-audio", text: null, message: sttFailures["bad-audio"] };
    const result = await runStt({ argv, audio: file, mode: validVoiceMode(mode) ? mode : "dictation",
      language: validVoiceLanguage(language) ? language : "auto", environment: this.environment });
    return result.ok ? { ...result, text: cleanTranscript(result.text) } : result;
  }
}
