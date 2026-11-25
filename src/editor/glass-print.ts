import { host } from "../host";
import { inkSvg } from "../../shared/glass-merge.mjs";
import { stickerSvg } from "../../shared/glass-art.mjs";
import { arrowConnections, kindOf, magnetLabel, readingOrder, sourceQuote } from "../../shared/glass-labels.mjs";

interface PrintMagnet { id: string; fields: Record<string, unknown>; kind?: string | null }
const escapeHtml = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function lines(text: string) { return text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).map(line => `<p>${escapeHtml(line)}</p>`).join(""); }

// Paint glass into the existing print document. Reading order, callouts, SVG ink and stickers,
// images at their magnet width, arrows as labelled connections, source quotes as footnotes.
export async function paintGlassPrint(container: HTMLElement, { note, title, magnets, scope }: {
  note: string; title: string; magnets: PrintMagnet[]; scope: "page" | "flat" | "handout";
}) {
  if (scope === "page") return;
  const ordered = readingOrder(magnets);
  if (scope === "handout") container.innerHTML = "";
  const section = document.createElement("section");
  section.className = `glass-print${scope === "handout" ? " glass-print-handout" : ""}`;
  section.dataset.scope = scope;
  if (scope === "handout") section.innerHTML = `<h1>${escapeHtml(title)} — Glass handout</h1><p class="glass-print-source">${escapeHtml(note)}</p>`;
  const footnotes: string[] = [];
  const connections = arrowConnections(ordered);
  for (const magnet of ordered) {
    const kind = kindOf(magnet), fields = magnet.fields ?? {};
    if (kind === "arrow") continue;
    const label = magnetLabel(kind, fields);
    const source = sourceQuote(fields);
    if (source.quote) footnotes.push(source.quote);
    const ref = source.quote ? `<sup class="glass-print-ref">[${footnotes.length}]</sup>` : "";
    const body: string[] = [`<strong>${escapeHtml(label)}</strong>${ref}`];
    if (kind === "sticky") body.push(lines(String(fields.text ?? "")));
    else if (kind === "comment") {
      const thread = Array.isArray(fields.thread) ? fields.thread : [];
      const entries = thread.map(entry => entry?.text).filter(text => typeof text === "string" && text.trim());
      body.push(lines(entries.length ? entries.join("\n") : String(fields.text ?? "")));
    } else if (kind === "card") {
      for (const value of [fields.title, fields.question, fields.answer]) if (typeof value === "string" && value.trim()) body.push(lines(value));
    } else if (kind === "image") {
      try {
        const asset = await host.glass!({ action: "asset", note, magnet: magnet.id, which: "display" });
        const width = Math.max(80, Math.min(Number(fields.w) || 320, 520));
        body.push(`<img src="data:${escapeHtml(asset.mime)};base64,${asset.base64}" alt="${escapeHtml(fields.name ?? label)}" width="${Math.round(width)}">`);
      } catch { body.push(`<p>${escapeHtml(fields.name ?? "Picture")}</p>`); }
    } else if (kind === "ink") {
      try { body.push(inkSvg(fields)); } catch { body.push("<p>Ink</p>"); }
    } else if (kind === "sticker") body.push(stickerSvg(String(fields.sticker)));
    section.insertAdjacentHTML("beforeend", `<aside class="glass-print-card" data-kind="${escapeHtml(kind)}">${body.join("")}</aside>`);
  }
  if (connections.length) {
    section.insertAdjacentHTML("beforeend", `<div class="glass-print-arrows"><strong>Connections</strong><ul>${connections.map(connection => `<li>${escapeHtml(connection.from)} → ${escapeHtml(connection.to)}${connection.label ? ` — ${escapeHtml(connection.label)}` : ""}</li>`).join("")}</ul></div>`);
  }
  if (footnotes.length) section.insertAdjacentHTML("beforeend", `<ol class="glass-print-notes">${footnotes.map(quote => `<li>${escapeHtml(quote)}</li>`).join("")}</ol>`);
  container.append(section);
}
