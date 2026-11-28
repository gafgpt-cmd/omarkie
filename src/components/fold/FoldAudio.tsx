import { useEffect, useState, type RefObject } from "react";
import { clockLabel } from "../../../shared/voice.mjs";
import { t } from "../../i18n";

// Lecture player in the level bar (design §9.5): play or pause the note's audio, and the second it is at.
export function FoldAudio({ audio }: { audio: RefObject<HTMLAudioElement | null> }) {
  const [playing, setPlaying] = useState(false), [second, setSecond] = useState(0);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const state = () => setPlaying(!element.paused);
    const time = () => setSecond(Math.floor(element.currentTime));
    const events = [["play", state], ["pause", state], ["ended", state], ["timeupdate", time], ["seeked", time]] as const;
    for (const [name, listener] of events) element.addEventListener(name, listener);
    return () => { for (const [name, listener] of events) element.removeEventListener(name, listener); };
  }, [audio]);
  const label = playing ? t("Pause lecture") : t("Play lecture");
  return <button type="button" className="fold-stop fold-play" aria-label={`${label}, ${clockLabel(second * 1000)}`} title={label}
    data-playing={playing || undefined} onClick={() => {
      const element = audio.current;
      if (!element) return;
      if (element.paused) void element.play().catch(() => {});
      else element.pause();
    }}>
    <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span><small>{clockLabel(second * 1000)}</small>
  </button>;
}
