// Which glass objects get DOM. Placement stays for every magnet; only the boxes near the
// viewport are mounted, so a 1,000-page note keeps tens of nodes, not thousands.
// One rule for note body and glass window: a box renders when it intersects viewport ± overscan.
// The focused object is force-mounted, else a screen reader loses its place when it scrolls out.

export interface GlassWindowViewport {
  top: number;
  height: number;
}

export interface GlassWindowItem {
  id: string;
  y: number;
  height: number;
}

export interface GlassWindowOptions {
  overscan?: number;
  cap?: number;
  force?: readonly string[];
}

export interface GlassWindowResult {
  mounted: Set<string>;
  total: number;
  inView: number;
  culled: number;
  forced: string[];
}

export const glassWindowDefaults = { overscan: 600, cap: 300 } as const;

export function glassWindow(items: readonly GlassWindowItem[], viewport: GlassWindowViewport, options: GlassWindowOptions = {}): GlassWindowResult {
  const force = new Set(options.force ?? []);
  const overscan = Math.max(0, options.overscan ?? glassWindowDefaults.overscan);
  const cap = Math.max(1, Math.floor(options.cap ?? glassWindowDefaults.cap));
  const total = items.length;
  // Before the first measurement the scroller has no height: mounting everything is the honest answer.
  if (!(viewport.height > 0)) return { mounted: new Set(items.map(item => item.id)), total, inView: total, culled: 0, forced: [...force] };
  const top = viewport.top - overscan, bottom = viewport.top + viewport.height + overscan;
  const centre = viewport.top + viewport.height / 2;
  const mounted = new Set<string>();
  const near: GlassWindowItem[] = [];
  for (const item of items) {
    if (force.has(item.id)) { mounted.add(item.id); continue; }
    if (item.y + item.height >= top && item.y <= bottom) near.push(item);
  }
  const inView = near.length;
  if (near.length > cap) {
    const byDistance = [...near].sort((left, right) => {
      const leftDistance = Math.abs(left.y + left.height / 2 - centre), rightDistance = Math.abs(right.y + right.height / 2 - centre);
      return leftDistance - rightDistance || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
    near.length = 0;
    near.push(...byDistance.slice(0, cap));
  }
  for (const item of near) mounted.add(item.id);
  return { mounted, total, inView, culled: total - mounted.size, forced: [...force] };
}

