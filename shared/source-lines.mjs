export function sourceLines(source) {
  const lines = [], offsets = [0];
  let from = 0;
  for (const ending of source.matchAll(/\r\n|\r|\n/g)) {
    lines.push(source.slice(from, ending.index));
    from = ending.index + ending[0].length;
    offsets.push(from);
  }
  lines.push(source.slice(from));
  offsets.push(source.length);
  return { lines, offsets };
}
