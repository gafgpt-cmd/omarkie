import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTime, pinPercent, type TimelineMark, type TimestampMark } from "../glass/timeline-model";

export interface TimelinePlace { x: number; y: number; width: number; height: number }

// Timeline glass: the player, its timestamp magnets and the transcript share one clock.
// The time axis stays left-to-right in RTL notes; only the card and its text mirror.
export default function GlassTimeline({ mark, timestamps, place, selected, onSelect, onPin, onDuration, onDelete }: {
  mark: TimelineMark; timestamps: TimestampMark[]; place: TimelinePlace; selected: boolean;
  onSelect(): void; onPin(time: number, label: string): void; onDuration(seconds: number): void; onDelete(): void;
}) {
  const player = useRef<HTMLMediaElement>(null);
  const cueList = useRef<HTMLOListElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(mark.duration);
  const [error, setError] = useState("");
  const reportDuration = useRef(onDuration);
  reportDuration.current = onDuration;

  const seek = useCallback((source: number) => {
    const media = player.current;
    if (!media) return;
    setError("");
    media.currentTime = Math.max(0, Math.min(media.duration || source, source));
    setTime(media.currentTime);
  }, []);

  const cues = mark.transcript;
  const active = useMemo(() => {
    let found = -1;
    for (let index = 0; index < cues.length; index += 1) if (cues[index].start <= time + 0.001) found = index; else break;
    return found;
  }, [cues, time]);

  // Playback follows the transcript: while playing, keep the active paragraph in view.
  useEffect(() => {
    if (!playing || active < 0) return;
    const row = cueList.current?.querySelector<HTMLElement>(`[data-glass-cue="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active, playing]);

  // The stored duration is display metadata; the media element is the source of truth.
  useEffect(() => {
    const media = player.current;
    if (!media) return;
    const loaded = () => {
      if (!Number.isFinite(media.duration) || media.duration <= 0) return;
      setDuration(media.duration);
      if (Math.abs(media.duration - mark.duration) > 0.5) reportDuration.current(media.duration);
    };
    const tick = () => setTime(media.currentTime);
    const start = () => setPlaying(true);
    const leave = () => setPlaying(false);
    const fail = () => setError("This audio or video could not be loaded.");
    media.addEventListener("loadedmetadata", loaded);
    media.addEventListener("timeupdate", tick);
    media.addEventListener("play", start);
    media.addEventListener("pause", leave);
    media.addEventListener("ended", leave);
    media.addEventListener("error", fail);
    if (media.readyState >= 1) loaded();
    return () => {
      media.removeEventListener("loadedmetadata", loaded);
      media.removeEventListener("timeupdate", tick);
      media.removeEventListener("play", start);
      media.removeEventListener("pause", leave);
      media.removeEventListener("ended", leave);
      media.removeEventListener("error", fail);
    };
  }, [mark.duration]);

  const pins = useMemo(() => timestamps.filter(stamp => stamp.timeline === mark.id), [timestamps, mark.id]);
  const activePin = useMemo(() => {
    let id: string | undefined;
    for (const pin of [...pins].sort((left, right) => left.t - right.t)) if (pin.t <= time + 0.001) id = pin.id; else break;
    return id;
  }, [pins, time]);
  const total = duration || Math.max(0, ...cues.map(cue => cue.end), ...pins.map(pin => pin.t));

  return <section className="glass-timeline" data-glass-timeline={mark.id} data-selected={selected || undefined}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${mark.w}px` }}
    tabIndex={0} aria-label={`Timeline, ${mark.title}`}
    onPointerDown={onSelect}
    onFocus={onSelect}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
      else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const media = player.current;
        if (!media) return;
        if (media.paused) void media.play().catch(() => setError("Press play in the player."));
        else media.pause();
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        seek(time + (event.key === "ArrowRight" ? 5 : -5));
      }
    }}>
    <header className="glass-timeline-head">
      <span className="glass-timeline-kind" aria-hidden="true" data-media={mark.media} />
      <strong>{mark.title}</strong>
      <span className="glass-timeline-clock" data-glass-player-clock>{formatTime(time)} / {formatTime(total)}</span>
      <button type="button" className="glass-timeline-close" aria-label="Delete timeline" title="Delete timeline" onClick={onDelete}>×</button>
    </header>
    {mark.media === "audio" && <audio ref={element => { player.current = element; }} src={mark.src} preload="metadata" controls data-glass-player={mark.id} />}
    {mark.media === "video" && <video ref={element => { player.current = element; }} src={mark.src} preload="metadata" controls
      className="glass-timeline-video" data-glass-player={mark.id} />}
    {error && <p className="glass-timeline-error" role="alert">{error}</p>}
    <div className="glass-timeline-track" role="group" aria-label="Timestamp magnets" dir="ltr"
      onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        seek(((event.clientX - rect.left) / rect.width) * total);
        onSelect();
      }}>
      <span className="glass-timeline-rail" aria-hidden="true" />
      <span className="glass-timeline-progress" aria-hidden="true" style={{ width: `${total > 0 ? Math.min(100, (time / total) * 100) : 0}%` }} />
      {pins.map(pin => <button type="button" key={pin.id} className="glass-timeline-pin" data-glass-timestamp={pin.id}
        data-active={pin.id === activePin || undefined} aria-current={pin.id === activePin ? "true" : undefined}
        style={{ insetInlineStart: `${pinPercent(pin.t, total) * 100}%` }}
        aria-label={`${formatTime(pin.t)}${pin.label ? `, ${pin.label}` : ""}`} title={pin.label ? `${formatTime(pin.t)} · ${pin.label}` : formatTime(pin.t)}
        onClick={() => seek(pin.t)}>
        <span aria-hidden="true" />
      </button>)}
    </div>
    <div className="glass-timeline-actions">
      <button type="button" data-glass-pin-here aria-label={`Pin the current time, ${formatTime(time)}`}
        onClick={() => onPin(time, cues[active]?.text.slice(0, 500) || `Pinned at ${formatTime(time)}`)}>Pin here</button>
      <span className="glass-timeline-hint">Space play · ←/→ 5 s</span>
    </div>
    {cues.length > 0 && <ol className="glass-timeline-transcript" ref={cueList} aria-label="Transcript">
      {cues.map((cue, index) => <li key={index}>
        <button type="button" data-glass-cue={index} data-active={index === active || undefined}
          aria-current={index === active ? "true" : undefined}
          aria-label={`${formatTime(cue.start)}. ${cue.text}`}
          onClick={() => seek(cue.start)}>
          <time dateTime={`PT${cue.start}S`} dir="ltr">{formatTime(cue.start)}</time>
          <span dir="auto">{cue.text}</span>
        </button>
      </li>)}
    </ol>}
  </section>;
}
