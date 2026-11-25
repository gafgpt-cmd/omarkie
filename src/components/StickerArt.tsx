import type { ReactNode } from "react";

// G8 sticker sheet: every mark is drawn here as SVG (no third-party pack, no network).
// Emoji use the reader's system font; numbers are set as text in a round badge.
const emoji: Record<string, string> = { smile: "🙂", cool: "😎", think: "🤔", fire: "🔥", bulb: "💡", "thumbs-up": "👍" };

function art(id: string): ReactNode {
  if (id.startsWith("number-")) {
    const number = id.slice(7);
    return <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#3d4652" stroke="#23262b" strokeWidth="1.4" />
      <text x="16" y="22" textAnchor="middle" fill="#fff" fontFamily="var(--interface-font, system-ui, sans-serif)" fontSize="17" fontWeight="700">{number}</text>
    </svg>;
  }
  switch (id) {
    case "star": return <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2.6 19.8 11.3 29.2 12 22 18.3 24.3 27.4 16 22.4 7.7 27.4 10 18.3 2.8 12 12.2 11.3Z" fill="#f4bc1c" stroke="#c58f08" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>;
    case "check": return <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#2f9e5f" stroke="#237a49" strokeWidth="1.4" />
      <path d="M9 16.6 14 21.6 23.4 11" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>;
    case "cross": return <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#cf3b32" stroke="#a42a22" strokeWidth="1.4" />
      <path d="M10.4 10.4 21.6 21.6M21.6 10.4 10.4 21.6" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
    </svg>;
    case "warning": return <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2.8 30.4 28.4H1.6Z" fill="#cf3b32" stroke="#a42a22" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M16 10.2v9.4" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="16" cy="24" r="2" fill="#fff" />
    </svg>;
    case "question": return <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#2f6fb5" stroke="#24578f" strokeWidth="1.4" />
      <text x="16" y="23" textAnchor="middle" fill="#fff" fontFamily="var(--interface-font, system-ui, sans-serif)" fontSize="19" fontWeight="700">?</text>
    </svg>;
    case "heart": return <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 28.2S4.2 20.6 4.2 12.6A6.8 6.8 0 0 1 16 8.4a6.8 6.8 0 0 1 11.8 4.2c0 8-11.8 15.6-11.8 15.6Z" fill="#e0446b" stroke="#b5304f" strokeWidth="1.4" />
    </svg>;
    default: return <span className="glass-sticker-emoji" aria-hidden="true">{emoji[id] ?? "★"}</span>;
  }
}

export default function StickerArt({ id, image, label }: { id?: string; image?: string; label: string }) {
  if (image) return <img className="glass-sticker-image" src={image} alt={label} draggable={false} />;
  return <span className="glass-sticker-art" role="img" aria-label={label}>{art(id ?? "")}</span>;
}
