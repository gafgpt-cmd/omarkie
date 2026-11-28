// One HTTP byte range against a file of `size` bytes: { start, end } inclusive, null when it cannot be
// satisfied (416), undefined when the header is absent or not one plain range (serve the whole file).
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix && size ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : null;
}
