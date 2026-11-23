Object.assign(window, {
  async renderProjectDiagrams(container: HTMLElement) {
    const { renderDiagrams } = await import("./diagrams");
    await renderDiagrams(container);
  },
});
