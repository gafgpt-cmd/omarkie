const kindNames: Record<string, string> = { paragraph: "Paragraph", heading: "Heading", list: "List", "list-item": "List item", table: "Table",
  "table-cell": "Cell", image: "Image", embed: "Embed", formula: "Formula", code: "Code", callout: "Callout", quote: "Quote", html: "HTML", divider: "Divider" };

export function elementKindName(kind: string) {
  return kindNames[kind] ?? kind;
}
