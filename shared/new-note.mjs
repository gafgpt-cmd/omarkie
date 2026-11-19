export function newNote(name, now = new Date().toISOString()) {
  const title = name.replace(/\.(md|markdown|mdown)$/i, "");
  return `---\ntype: Reference\ntitle: ${JSON.stringify(title)}\ntags: []\ngenerated: { by: "process:editor", at: ${JSON.stringify(now)} }\n---\n\n`;
}
