export function hookArguments(configured) {
  let argv;
  try { argv = configured.startsWith("[") ? JSON.parse(configured) : [configured]; }
  catch { return null; }
  return Array.isArray(argv) && argv.length && argv.every(part => typeof part === "string" && part && !part.includes("\0")) ? argv : null;
}
