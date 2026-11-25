// G18: one sticker sheet for the renderer, print, Markdown flatten and the CLI.
// Every mark is SVG text, so an export writes it as a file instead of rasterizing.
const emoji = { smile: "🙂", cool: "😎", think: "🤔", fire: "🔥", bulb: "💡", "thumbs-up": "👍" };

const names = {
  star: "Star sticker", check: "Check sticker", cross: "Red cross sticker", warning: "Red warning sticker",
  question: "Question sticker", heart: "Heart sticker", smile: "Smile sticker", cool: "Cool sticker",
  think: "Thinking sticker", fire: "Fire sticker", bulb: "Idea sticker", "thumbs-up": "Thumbs up sticker",
};

export function stickerName(id) {
  const value = String(id ?? "");
  if (/^number-[1-9]$/.test(value)) return `Number ${value.slice(7)} sticker`;
  return names[value] ?? `${value || "Sticker"} sticker`;
}

export function stickerMarkup(id) {
  if (/^number-[1-9]$/.test(id)) {
    return `<circle cx="16" cy="16" r="14" fill="#3d4652" stroke="#23262b" stroke-width="1.4"/><text x="16" y="22" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif" font-size="17" font-weight="700">${id.slice(7)}</text>`;
  }
  switch (id) {
    case "star": return `<path d="M16 2.6 19.8 11.3 29.2 12 22 18.3 24.3 27.4 16 22.4 7.7 27.4 10 18.3 2.8 12 12.2 11.3Z" fill="#f4bc1c" stroke="#c58f08" stroke-width="1.4" stroke-linejoin="round"/>`;
    case "check": return `<circle cx="16" cy="16" r="14" fill="#2f9e5f" stroke="#237a49" stroke-width="1.4"/><path d="M9 16.6 14 21.6 23.4 11" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "cross": return `<circle cx="16" cy="16" r="14" fill="#cf3b32" stroke="#a42a22" stroke-width="1.4"/><path d="M10.4 10.4 21.6 21.6M21.6 10.4 10.4 21.6" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`;
    case "warning": return `<path d="M16 2.8 30.4 28.4H1.6Z" fill="#cf3b32" stroke="#a42a22" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 10.2v9.4" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><circle cx="16" cy="24" r="2" fill="#fff"/>`;
    case "question": return `<circle cx="16" cy="16" r="14" fill="#2f6fb5" stroke="#24578f" stroke-width="1.4"/><text x="16" y="23" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif" font-size="19" font-weight="700">?</text>`;
    case "heart": return `<path d="M16 28.2S4.2 20.6 4.2 12.6A6.8 6.8 0 0 1 16 8.4a6.8 6.8 0 0 1 11.8 4.2c0 8-11.8 15.6-11.8 15.6Z" fill="#e0446b" stroke="#b5304f" stroke-width="1.4"/>`;
    default: {
      const value = emoji[id];
      if (!value) return `<path d="M16 2.6 19.8 11.3 29.2 12 22 18.3 24.3 27.4 16 22.4 7.7 27.4 10 18.3 2.8 12 12.2 11.3Z" fill="#f4bc1c" stroke="#c58f08" stroke-width="1.4" stroke-linejoin="round"/>`;
      return `<text x="16" y="25" text-anchor="middle" font-size="24">${value}</text>`;
    }
  }
}

export function stickerSvg(id, { size = 72 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" role="img" aria-label="${stickerName(id).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">${stickerMarkup(id)}</svg>`;
}
