# Glass voice (G21)

Local speech-to-text for the Glass overlay. One CLI hook; no network, no bundled model.

## Setup

```
OMARKIE_STT="voxtype transcribe {wav}"     # or any whisper CLI; {wav} is optional
OMARKIE_STT_KEY="Alt+V"                    # push-to-talk key; optional
OMARKIE_STT_LANG="auto"                    # or es, en, en-GB; optional
```

- Hook gets `OMARKIE_STT_AUDIO` = path to a 16 kHz mono 16-bit PCM WAV.
- Print the transcript on stdout; exit 0.
- Exit codes: 2 no speech, 3 bad audio, 4 missing model, 5 language, 64 config.
- No hook: voice buttons and the bubble microphone do not render.

## Use

| Surface | Action |
|---|---|
| Pencil case mic | Click a paragraph to dictate; speech lands as a sticky there. |
| `Alt+V` | Hold to talk; a quick tap keeps listening, next tap stops. Escape cancels. |
| Voice memo | Click a paragraph; audio + transcript become a magnet on the Media layer. |
| Lecture | One recording, split at pauses; Mark starts a section; Save writes one new note. |
| Bubble mic | Fills the question only. X-ray and Send are unchanged. |

- Dictation and memos reset the tool to Select when recording ends, so the next click never records by accident.
- Memo transcript is indexed; `omarkie-axi find <word>` finds it.
- Audio lives in `.omarkie/assets/` (inside-vault mode) and never leaves the machine.

## Lecture note

- `Lecture YYYY-MM-DD HHMM.md` beside the source note; `(2)` on a clash.
- Audio: `<title>.m4a` (MP4/Opus) beside it, embedded as `![[<title>.m4a]]`. No MP4 recorder: note only, no audio.
- Sections `## mm:ss`: at 0:00, at each Mark, every 5 min.
- Paragraphs: `mm:ss.t text`, time = first word in the audio (0.1 s, floored). New paragraph after a 1.5 s pause or 45 s.
- Times are on the `.m4a` clock: the first 20 s of recorder and transcriber audio are matched at Save, so a seek lands on the word.
- Fold Topic lines and cards play the audio from that second (see `document-workflows.md`).

## AXI

```
omarkie-axi voice transcribe --wav take.wav [--mode dictation|memo|lecture|ask] [--language es]
omarkie-axi memo list --note note.md [--full]
```

## Failure rules

- Hook fails: audio is kept under `voice-failed/` (newest 20) and the UI says why.
- Empty transcript: no sticky, no memo; notice `No speech was heard.`
- Lecture with no transcript: nothing is written.
