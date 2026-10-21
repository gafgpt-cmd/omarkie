interface Recorder {
  name: string; selector: string;
  stateGetter(element: Element): unknown;
  stateRestorer(element: Element, state: unknown): void;
}
// Session state follows document identity and stable block IDs, never Markdown.
export class StateRecorder {
  private records = new Map<string, { definition: Recorder; key: string; nodes: { element: Element; id: string }[]; states: Map<string, Map<string, unknown>> }>();
  private root: () => HTMLElement | null;
  private documentKey: () => string;
  constructor(root: () => HTMLElement | null, documentKey: () => string) { this.root = root; this.documentKey = documentKey; }
  register = (definition: Recorder) => {
    this.unregister(definition.name);
    this.records.set(definition.name, { definition, key: this.documentKey(), nodes: this.collect(definition.selector), states: new Map() });
  };
  unregister = (name: string) => { this.records.delete(name); };
  // Windowed rendering keeps only nearby blocks in the DOM, so ids come from the block, never from the position in the document.
  private collect(selector: string) {
    const nodes = [...(this.root()?.querySelectorAll(selector) || [])].filter(element => !element.classList.contains("md-window-spacer"));
    return nodes.map((element, index) => {
      const own = element.getAttribute("cid") || element.getAttribute("data-cid");
      if (own) return { element, id: own };
      const block = element.closest("[cid],[data-cid]");
      return { element, id: block ? `${block.getAttribute("cid") || block.getAttribute("data-cid")}:${[...block.querySelectorAll(selector)].indexOf(element)}` : String(index) };
    });
  }
  sync() {
    for (const record of this.records.values()) {
      // Merge: blocks outside the rendered window keep their saved state until they return.
      const saved = record.states.get(record.key) || new Map<string, unknown>();
      for (const { element, id } of record.nodes) { const state = record.definition.stateGetter(element); if (state) saved.set(id, state); else saved.delete(id); }
      if (saved.size) record.states.set(record.key, saved); else record.states.delete(record.key);
      // Bound session memory across long folder-browsing sessions.
      if (record.states.size > 100) record.states.delete(record.states.keys().next().value!);
      record.key = this.documentKey();
      record.nodes = this.collect(record.definition.selector);
      const restore = record.states.get(record.key);
      if (restore) for (const { element, id } of record.nodes) { const value = restore.get(id); if (value) record.definition.stateRestorer(element, value); }
    }
  }
  clear() { this.records.clear(); }
}
