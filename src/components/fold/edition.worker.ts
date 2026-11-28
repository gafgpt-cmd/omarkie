// Nueva edición off the main thread: folding two long editions takes far more than one frame.
import { foldEdition } from "../../../shared/fold-edition.mjs";
import type { FoldPin } from "../../../shared/fold-units.mjs";

interface Job { id: number; old: string; next: string; pins: FoldPin[] }

self.onmessage = ({ data }: MessageEvent<Job>) => {
  try { postMessage({ id: data.id, edition: foldEdition(data.old, data.next, { pins: data.pins }) }); }
  catch (error) { postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
