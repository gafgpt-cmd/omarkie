// The second frame runs after the browser has had a chance to paint the document.
export function afterDocumentPaint(start: () => void) {
  let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(start); });
  return () => cancelAnimationFrame(frame);
}
