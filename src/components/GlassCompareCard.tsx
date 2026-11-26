import { useEffect, useState } from "react";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { glassAsset } from "../glass/glass-assets";
import type { GlassImage } from "../glass/image-model";
import type { CompareMark } from "../glass/visual-model";
import CompareSlider from "./CompareSlider";

interface Props {
  compare: CompareMark;
  place: { x: number; y: number; width: number; height: number };
  note: string;
  images: GlassImage[];
  onChange(value: number): void;
  onCommit(value: number): void;
  onSwap(): void;
  onDelete(): void;
}

// A pinned before/after card. Both pictures are local glass assets; nothing leaves the machine.
export default function GlassCompareCard({ compare, place, note, images, onChange, onCommit, onSwap, onDelete }: Props) {
  const left = images.find(image => image.id === compare.left);
  const right = images.find(image => image.id === compare.right);
  const [leftUrl, setLeftUrl] = useState<string | null>(null);
  const [rightUrl, setRightUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (image: GlassImage | undefined, set: (url: string | null) => void) => {
      if (!image) { set(null); return; }
      void glassAsset(note, image.id, image.display ? "display" : "original").then(url => { if (alive) set(url ?? null); });
    };
    load(left, setLeftUrl);
    load(right, setRightUrl);
    return () => { alive = false; };
  }, [note, left?.id, left?.display, right?.id, right?.display]);
  return <div className="glass-compare-card" data-compare-card={compare.id}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px` }}>
    <div className="glass-compare-head">
      <strong>{left?.name ?? "Missing"} / {right?.name ?? "Missing"}</strong>
      <div className="glass-compare-actions">
        <button type="button" data-compare-swap aria-label="Swap sides" title="Swap sides" onClick={onSwap}><ArrowLeftRight size={12} /></button>
        <button type="button" data-compare-delete aria-label="Delete compare" title="Delete compare" onClick={onDelete}><Trash2 size={12} /></button>
      </div>
    </div>
    <CompareSlider left={leftUrl} right={rightUrl} leftAlt={left?.name ?? "Before image"} rightAlt={right?.name ?? "After image"}
      value={compare.value} direction={compare.direction} before={compare.before} after={compare.after}
      onChange={onChange} onCommit={onCommit} onSwap={onSwap} onDelete={onDelete} />
  </div>;
}
