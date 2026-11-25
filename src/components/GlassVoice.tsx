import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import type { VoiceMemo } from "../glass/voice-model";
import { timestampLabel } from "../../shared/voice.mjs";

// G21: the memo magnet is the audio plus its transcript; the audio bytes stay in the vault.
async function audioUrl(note: string, magnet: string) {
  const reply = await window.desktop?.glass?.({ note, magnet, action: "asset", which: "audio" });
  if (!reply?.ok) throw new Error(reply?.error ?? "The recording could not be opened.");
  const { base64, mime } = reply.value ?? {};
  if (typeof base64 !== "string" || !base64) throw new Error("The recording is missing.");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: typeof mime === "string" ? mime : "audio/webm" }));
}

interface Place { x: number; y: number; width: number; height: number }

export default function GlassVoice({ memo, place, note, selected, onSelect, onDelete }: {
  memo: VoiceMemo; place: Place; note: string; selected: boolean;
  onSelect(): void; onDelete(): void;
}) {
  const [playing, setPlaying] = useState(false), [position, setPosition] = useState(0), [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | undefined>(undefined), url = useRef("");

  useEffect(() => () => {
    audio.current?.pause();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = "";
  }, []);

  async function toggle() {
    setError("");
    try {
      if (!audio.current || !url.current) {
        url.current = await audioUrl(note, memo.id);
        const element = new Audio(url.current);
        element.addEventListener("timeupdate", () => setPosition(element.currentTime * 1000));
        element.addEventListener("ended", () => { setPlaying(false); setPosition(0); });
        element.addEventListener("error", () => { setPlaying(false); setError("The recording could not be played."); });
        audio.current = element;
      }
      if (audio.current.paused) { await audio.current.play(); setPlaying(true); }
      else { audio.current.pause(); setPlaying(false); }
    } catch (failure) { setPlaying(false); setError((failure as Error).message); }
  }

  const duration = memo.duration || memo.segments.at(-1)?.endMs || 0;
  return <div className="glass-voice" data-glass-magnet={memo.id} data-glass-layer="media" data-voice-memo={memo.id}
    data-selected={selected || undefined} data-voice-playing={playing || undefined}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px` }}
    onPointerDown={event => { event.stopPropagation(); onSelect(); }}>
    <button type="button" className="glass-voice-play" data-voice-play aria-label={playing ? "Pause voice memo" : "Play voice memo"}
      title={playing ? "Pause" : "Play"} onClick={() => void toggle()}>
      {playing ? <Pause size={14} /> : <Play size={14} />}
    </button>
    <div className="glass-voice-body">
      <div className="glass-voice-meta">
        <span>Voice memo</span>
        <time data-voice-clock>{timestampLabel(playing ? position : duration)}</time>
        {memo.lang !== "auto" && <small data-voice-lang>{memo.lang}</small>}
      </div>
      <p className="glass-voice-text" data-voice-text title={memo.text}>{memo.text || "No transcript"}</p>
      {error && <p className="glass-voice-error" role="alert">{error}</p>}
    </div>
    <button type="button" className="glass-voice-delete" data-voice-delete aria-label="Delete voice memo" title="Delete"
      onClick={onDelete}><Trash2 size={13} /></button>
  </div>;
}
