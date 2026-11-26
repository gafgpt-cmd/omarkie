import { Eye, EyeOff, Lock, Unlock } from "lucide-react";
import { useEffect, useState } from "react";
import { glassLayerIds, glassLayerNames, layerCreated, type GlassLayerId } from "../../shared/glass-layers.mjs";
import { patchGlassLayer, publishGlassLayers, useGlassLayerCounts, useGlassLayers } from "../glass/layers";
import { t } from "../i18n";

interface Props {
  note?: string;
  glassOn: boolean;
  saved: boolean;
  compact: boolean;
  studyCounts: Partial<Record<GlassLayerId, number>>;
  onNotice(message: string): void;
}

// Five shared layers, auto-made on first use. The rail row owns eye, lock, opacity and count;
// the compact chip keeps the same controls reachable at 720 px.
export default function GlassLayers({ note, glassOn, saved, compact, studyCounts, onNotice }: Props) {
  const layers = useGlassLayers(note);
  const counts = useGlassLayerCounts(note);
  const [drafts, setDrafts] = useState<Partial<Record<GlassLayerId, number>>>({});
  const [pulse, setPulse] = useState<string>();
  const editable = !!note && !!saved && glassOn;

  useEffect(() => {
    if (!note) return;
    let current = true;
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      const reply = await window.desktop?.glass?.({ note, action: "layers" });
      if (!current || mine !== seq || !reply?.ok) return;
      publishGlassLayers(note, reply.value.layers, reply.value.counts);
    };
    void load();
    let timer: number | undefined;
    const stop = window.desktop?.onGlassChanged?.((event: { note?: string; action?: string } | undefined) => {
      if (event?.note !== note || !["layer", "add", "set", "delete", "restore", "bring"].includes(event.action ?? "")) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 120);
    });
    return () => { current = false; window.clearTimeout(timer); stop?.(); };
  }, [note]);

  const change = async (layer: GlassLayerId, patch: { visible?: boolean; locked?: boolean; opacity?: number }) => {
    if (!editable || !note) return;
    patchGlassLayer(layer, patch);
    setPulse(layer);
    const reply = await window.desktop?.glass?.({ note, action: "layer", layer, ...patch });
    setPulse(undefined);
    if (!reply?.ok) {
      onNotice(reply?.error ?? t("Could not change the layer."));
      const reload = await window.desktop?.glass?.({ note, action: "layers" });
      if (reload?.ok) publishGlassLayers(note, reload.value.layers, reload.value.counts);
      return;
    }
    publishGlassLayers(note, reply.value.layers, reply.value.counts);
  };

  const commitOpacity = (layer: GlassLayerId) => {
    const value = drafts[layer];
    if (value === undefined) return;
    setDrafts(current => ({ ...current, [layer]: undefined }));
    if (value !== layers[layer].opacity) void change(layer, { opacity: value });
  };

  if (!note) return null;
  if (!glassOn) return <section className="glass-layers" aria-label={t("Glass layers")}>
    <h3>{t("Glass layers")}</h3>
    <p className="glass-layers-empty">{t("Glass is off. Press G to show glass, then its layers.")}</p>
  </section>;
  const shown = glassLayerIds.filter(id => layerCreated(id, layers[id], counts[id] ?? 0, studyCounts[id] ?? 0));
  const controls = (id: GlassLayerId) => {
    const name = t(glassLayerNames[id]), layer = layers[id];
    return <>
      <button type="button" className="glass-layer-eye" aria-pressed={layer.visible}
        aria-label={t(layer.visible ? "Hide {{layer}} layer" : "Show {{layer}} layer", { layer: name })}
        title={t(layer.visible ? "Hide layer" : "Show layer")} disabled={!editable}
        onClick={() => void change(id, { visible: !layer.visible })}>
        {layer.visible ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
      </button>
      <button type="button" className="glass-layer-lock" aria-pressed={layer.locked}
        aria-label={t(layer.locked ? "Unlock {{layer}} layer" : "Lock {{layer}} layer", { layer: name })}
        title={t(layer.locked ? "Unlock layer" : "Lock layer")} disabled={!editable}
        onClick={() => void change(id, { locked: !layer.locked })}>
        {layer.locked ? <Lock size={13} aria-hidden="true" /> : <Unlock size={13} aria-hidden="true" />}
      </button>
      <label className="glass-layer-opacity">
        <input type="range" min="0" max="100" step="1" value={drafts[id] ?? layer.opacity}
          aria-label={t("{{layer}} opacity", { layer: name })} disabled={!editable}
          onChange={event => setDrafts(current => ({ ...current, [id]: Number(event.target.value) }))}
          onPointerUp={() => commitOpacity(id)} onKeyUp={() => commitOpacity(id)} onBlur={() => commitOpacity(id)} />
      </label>
    </>;
  };
  const total = (id: GlassLayerId) => (counts[id] ?? 0) + (studyCounts[id] ?? 0);
  return <section className="glass-layers" aria-label={t("Glass layers")}>
    <h3>{t("Glass layers")}</h3>
    {shown.length === 0
      ? <p className="glass-layers-empty">{t("Layers appear when you first add ink, a note, a photo, a card or a comment.")}</p>
      : compact
        ? <ul className="glass-layer-chips">{shown.map(id => <li key={id} data-glass-layer-row={id} data-pulse={pulse === id || undefined}
            aria-label={t("{{layer}} layer, {{count}} marks", { layer: t(glassLayerNames[id]), count: total(id) })}>
            {controls(id)}<span className="glass-layer-name">{t(glassLayerNames[id])}</span><small>{total(id) || ""}</small>
          </li>)}</ul>
        : <ul className="glass-layer-list">{shown.map(id => <li key={id} className="glass-layer-row" data-glass-layer-row={id} data-pulse={pulse === id || undefined}
            aria-label={t("{{layer}} layer, {{count}} marks", { layer: t(glassLayerNames[id]), count: total(id) })}>
            {controls(id)}<span className="glass-layer-name">{t(glassLayerNames[id])}</span><small aria-hidden="true">{total(id) || ""}</small>
          </li>)}</ul>}
  </section>;
}
