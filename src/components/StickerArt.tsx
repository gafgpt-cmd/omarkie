import { stickerMarkup } from "../../shared/glass-art.mjs";

// G8/G18: the sticker sheet lives in shared/glass-art.mjs, so the page, the print
// document, the Markdown flatten and the CLI draw exactly the same marks.
export default function StickerArt({ id, image, label }: { id?: string; image?: string; label: string }) {
  if (image) return <img className="glass-sticker-image" src={image} alt={label} draggable={false} />;
  return <span className="glass-sticker-art" role="img" aria-label={label}
    dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 32 32" aria-hidden="true">${stickerMarkup(id ?? "")}</svg>` }} />;
}
