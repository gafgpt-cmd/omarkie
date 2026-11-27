import { t } from "../i18n.ts";
type Axis = "row" | "column";
export interface TableHandleActions {
  move(axis: Axis, from: number, to: number, cid: string): boolean;
  resize(rows: number, columns: number, cid: string): boolean;
  filledOutside(rows: number, columns: number, cid: string): number;
}
const grip = (axis: Axis) => `<svg viewBox="0 0 ${axis === "row" ? "8 14" : "14 8"}" aria-hidden="true">${[0, 1, 2].flatMap(i => [0, 1].map(j => {
  const [x, y] = axis === "row" ? [1.5 + j * 5, 2 + i * 5] : [2 + i * 5, 1.5 + j * 5];
  return `<circle cx="${x}" cy="${y}" r="1.3" fill="currentColor"/>`;
})).join("")}</svg>`;
export const tableLimits = { rows: 100, columns: 30 };
// Pointer previews draw overlays only; a drop, a handle key or a picked size is one table transaction.
export class TableHandles {
  readonly sizeButton: HTMLButtonElement;
  private grips: Record<Axis, HTMLButtonElement>;
  private ghost = document.createElement("div");
  private line = document.createElement("div");
  private picker = document.createElement("div");
  private pickerLabel = document.createElement("div");
  private pickerGrid = document.createElement("div");
  private pickerNote = document.createElement("div");
  private cell: HTMLTableCellElement | null = null;
  private drag: { axis: Axis; from: number; to: number; pointer: number; table: HTMLTableElement } | null = null;
  private size = { rows: 0, columns: 0, current: { rows: 0, columns: 0 }, cid: "" };
  private parent: HTMLElement;
  private actions: TableHandleActions;
  constructor(parent: HTMLElement, actions: TableHandleActions) {
    this.parent = parent; this.actions = actions;
    this.grips = { row: this.makeGrip("row"), column: this.makeGrip("column") };
    this.ghost.className = "table-drag-ghost"; this.line.className = "table-drop-line";
    this.ghost.hidden = this.line.hidden = true;
    this.sizeButton = document.createElement("button");
    this.sizeButton.type = "button"; this.sizeButton.className = "table-size-button";
    this.sizeButton.textContent = t("Table size");
    this.sizeButton.setAttribute("aria-haspopup", "dialog");
    this.sizeButton.addEventListener("mousedown", event => event.preventDefault());
    this.sizeButton.addEventListener("click", () => this.picker.hidden ? this.openPicker() : this.closePicker(true));
    this.picker.className = "table-size-picker"; this.picker.hidden = true; this.picker.contentEditable = "false";
    this.picker.role = "dialog"; this.picker.setAttribute("aria-label", t("Table size"));
    this.pickerGrid.className = "table-size-grid"; this.pickerGrid.tabIndex = 0; this.pickerGrid.role = "spinbutton";
    this.pickerGrid.setAttribute("aria-label", t("Rows and columns: arrow keys change, Enter applies"));
    this.pickerLabel.className = "table-size-label"; this.pickerNote.className = "table-size-note";
    this.pickerNote.setAttribute("aria-live", "polite");
    this.picker.append(this.pickerLabel, this.pickerGrid, this.pickerNote);
    // Focus leaving the picker closes it without a transaction.
    this.picker.addEventListener("focusout", event => { const next = event.relatedTarget as Node | null; if (!next || (!this.picker.contains(next) && next !== this.sizeButton)) this.closePicker(false); });
    this.picker.addEventListener("pointerdown", event => event.preventDefault());
    this.pickerGrid.addEventListener("pointermove", event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-size]");
      if (!target) return;
      const [rows, columns] = target.dataset.size!.split("x").map(Number);
      this.pick(rows, columns);
    });
    this.pickerGrid.addEventListener("click", event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-size]");
      if (!target) return;
      const [rows, columns] = target.dataset.size!.split("x").map(Number);
      this.pick(rows, columns); this.applySize();
    });
    this.pickerGrid.addEventListener("keydown", this.pickerKey);
    for (const element of [this.ghost, this.line, this.grips.row, this.grips.column, this.picker]) parent.append(element);
  }
  private makeGrip(axis: Axis) {
    const button = document.createElement("button");
    button.type = "button"; button.className = `table-grip table-grip-${axis}`; button.hidden = true;
    button.contentEditable = "false"; button.innerHTML = grip(axis);
    const label = axis === "row" ? t("Move row: drag, or press Up and Down") : t("Move column: drag, or press Left and Right");
    button.setAttribute("aria-label", label); button.title = label;
    button.addEventListener("pointerdown", event => this.startDrag(event, axis));
    button.addEventListener("keydown", event => this.gripKey(event, axis));
    return button;
  }
  set inert(value: boolean) {
    for (const element of [this.grips.row, this.grips.column, this.picker]) element.inert = value;
    if (value) this.update(null);
  }
  private offset(rect: DOMRect) {
    const bounds = this.parent.getBoundingClientRect();
    return { left: rect.left - bounds.left + this.parent.scrollLeft, top: rect.top - bounds.top + this.parent.scrollTop };
  }
  private place(element: HTMLElement, rect: DOMRect, dx = 0, dy = 0, width?: number, height?: number) {
    const at = this.offset(rect);
    element.style.left = `${at.left + dx}px`; element.style.top = `${at.top + dy}px`;
    if (width !== undefined) element.style.width = `${width}px`;
    if (height !== undefined) element.style.height = `${height}px`;
  }
  // The caret's cell picks which row and column the handles grab.
  update(cell: HTMLTableCellElement | null) {
    if (this.drag) return;
    this.cell = cell;
    const table = cell?.closest("table"), row = cell?.parentElement as HTMLTableRowElement | undefined;
    this.grips.row.hidden = !cell || !row || row.rowIndex < 1;
    this.grips.column.hidden = !cell || !table;
    if (!cell || !table || !row) { this.closePicker(false); return; }
    const tableRect = table.getBoundingClientRect(), rowRect = row.getBoundingClientRect(), header = table.rows[0]?.cells[cell.cellIndex];
    if (row.rowIndex >= 1) this.place(this.grips.row, rowRect, tableRect.left - rowRect.left - 16, rowRect.height / 2 - 9);
    if (header) { const rect = header.getBoundingClientRect(); this.place(this.grips.column, rect, rect.width / 2 - 9, -6); }
    if (!this.picker.hidden && table.dataset.cid !== this.size.cid) this.closePicker(false);
  }
  destroy() {
    this.endDrag(false);
    for (const element of [this.ghost, this.line, this.grips.row, this.grips.column, this.picker]) element.remove();
  }
  private gripKey(event: KeyboardEvent, axis: Axis) {
    const step = axis === "row" ? { ArrowUp: -1, ArrowDown: 1 }[event.key] : { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (event.key === "Escape" && this.drag) { event.preventDefault(); this.endDrag(false); return; }
    if (!step || !this.cell || event.isComposing) return;
    event.preventDefault();
    const table = this.cell.closest("table")!, from = axis === "row" ? (this.cell.parentElement as HTMLTableRowElement).rowIndex : this.cell.cellIndex;
    const count = axis === "row" ? table.rows.length : table.rows[0].cells.length, to = from + step;
    if (to < (axis === "row" ? 1 : 0) || to >= count) return;
    const button = this.grips[axis];
    if (this.actions.move(axis, from, to, table.dataset.cid!)) requestAnimationFrame(() => { if (!button.hidden) button.focus({ preventScroll: true }); });
  }
  private items(drag: NonNullable<TableHandles["drag"]>) {
    return drag.axis === "row" ? [...drag.table.rows].slice(1).map(row => ({ index: row.rowIndex, rect: row.getBoundingClientRect() }))
      : [...drag.table.rows[0].cells].map(cell => ({ index: cell.cellIndex, rect: cell.getBoundingClientRect() }));
  }
  private startDrag(event: PointerEvent, axis: Axis) {
    if (event.button !== 0 || !this.cell) return;
    event.preventDefault();
    const table = this.cell.closest("table")!, from = axis === "row" ? (this.cell.parentElement as HTMLTableRowElement).rowIndex : this.cell.cellIndex;
    this.drag = { axis, from, to: from, pointer: event.pointerId, table };
    const button = this.grips[axis];
    button.setPointerCapture(event.pointerId);
    button.classList.add("is-dragging");
    button.addEventListener("pointermove", this.dragMove);
    button.addEventListener("pointerup", this.dragDrop);
    button.addEventListener("pointercancel", this.dragCancel);
    button.addEventListener("lostpointercapture", this.dragCancel);
    window.addEventListener("keydown", this.dragKey, true);
    const tableRect = table.getBoundingClientRect(), source = this.items(this.drag).find(item => item.index === from)!.rect;
    if (axis === "row") this.place(this.ghost, source, tableRect.left - source.left, 0, tableRect.width, source.height);
    else this.place(this.ghost, source, 0, tableRect.top - source.top, source.width, tableRect.height);
    this.ghost.hidden = false;
    this.dragMove(event);
  }
  private dragMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    const at = drag.axis === "row" ? event.clientY : event.clientX, items = this.items(drag), others = items.filter(item => item.index !== drag.from);
    const middle = (rect: DOMRect) => drag.axis === "row" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    const slot = others.filter(item => middle(item.rect) < at).length;
    drag.to = (drag.axis === "row" ? 1 : 0) + slot;
    const tableRect = drag.table.getBoundingClientRect(), edge = slot ? others[slot - 1].rect : others[0]?.rect ?? items[0].rect;
    if (drag.axis === "row") this.place(this.line, edge, tableRect.left - edge.left, (slot ? edge.height : 0) - 1, tableRect.width, 2);
    else this.place(this.line, edge, (slot ? edge.width : 0) - 1, tableRect.top - edge.top, 2, tableRect.height);
    this.line.hidden = drag.to === drag.from;
  };
  private dragDrop = (event: PointerEvent) => { if (this.drag && event.pointerId === this.drag.pointer) this.endDrag(true); };
  private dragCancel = () => this.endDrag(false);
  private dragKey = (event: KeyboardEvent) => {
    if (!this.drag || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); this.endDrag(false);
  };
  private endDrag(commit: boolean) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const button = this.grips[drag.axis];
    button.classList.remove("is-dragging");
    button.removeEventListener("pointermove", this.dragMove);
    button.removeEventListener("pointerup", this.dragDrop);
    button.removeEventListener("pointercancel", this.dragCancel);
    button.removeEventListener("lostpointercapture", this.dragCancel);
    window.removeEventListener("keydown", this.dragKey, true);
    if (button.hasPointerCapture(drag.pointer)) button.releasePointerCapture(drag.pointer);
    this.ghost.hidden = this.line.hidden = true;
    if (commit && drag.to !== drag.from) this.actions.move(drag.axis, drag.from, drag.to, drag.table.dataset.cid!);
    else this.update(this.cell?.isConnected ? this.cell : null);
  }
  openPicker() {
    const table = this.cell?.closest("table");
    if (!table?.dataset.cid) return;
    const current = { rows: table.rows.length, columns: table.rows[0]?.cells.length || 1 };
    this.size = { ...current, current, cid: table.dataset.cid };
    this.picker.hidden = false; this.sizeButton.setAttribute("aria-expanded", "true");
    this.renderPicker();
    const rect = this.sizeButton.getBoundingClientRect();
    this.place(this.picker, rect, 0, rect.height + 4);
    this.pickerGrid.focus({ preventScroll: true });
  }
  private closePicker(returnFocus: boolean) {
    if (this.picker.hidden) return;
    this.picker.hidden = true; this.sizeButton.setAttribute("aria-expanded", "false");
    if (returnFocus && this.cell?.isConnected) this.cell.closest<HTMLElement>("[contenteditable=true]")?.focus({ preventScroll: true });
  }
  private pick(rows: number, columns: number) {
    rows = Math.max(2, Math.min(tableLimits.rows, rows)); columns = Math.max(1, Math.min(tableLimits.columns, columns));
    if (rows === this.size.rows && columns === this.size.columns) return;
    this.size.rows = rows; this.size.columns = columns;
    this.renderPicker();
  }
  private renderPicker() {
    const { rows, columns, current, cid } = this.size;
    const shownRows = Math.min(tableLimits.rows, Math.max(8, rows + 1, current.rows + 1)), shownColumns = Math.min(tableLimits.columns, Math.max(8, columns + 1, current.columns + 1));
    this.pickerGrid.style.setProperty("--columns", String(shownColumns));
    let html = "";
    for (let r = 1; r <= shownRows; r++) for (let c = 1; c <= shownColumns; c++)
      html += `<span data-size="${r}x${c}"${r <= rows && c <= columns ? " data-on" : ""}${r <= current.rows && c <= current.columns ? " data-current" : ""}${r === 1 ? " data-header" : ""}></span>`;
    this.pickerGrid.innerHTML = html;
    const label = t("Rows {{rows}} · Columns {{columns}}", { rows, columns });
    this.pickerLabel.textContent = label;
    this.pickerGrid.setAttribute("aria-valuetext", label);
    const lost = rows < current.rows || columns < current.columns ? this.actions.filledOutside(rows, columns, cid) : 0;
    this.pickerNote.textContent = lost ? t("Removes {{count}} filled cells", { count: lost }) : rows === current.rows && columns === current.columns ? t("Current size") : "";
    this.pickerNote.classList.toggle("is-warning", lost > 0);
  }
  private pickerKey = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const move = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, [number, number]>)[event.key];
    if (move) { event.preventDefault(); this.pick(this.size.rows + move[0], this.size.columns + move[1]); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.applySize(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closePicker(true); }
  };
  private applySize() {
    const { rows, columns, current, cid } = this.size;
    this.closePicker(false);
    if (rows === current.rows && columns === current.columns) { this.cell?.closest<HTMLElement>("[contenteditable=true]")?.focus({ preventScroll: true }); return; }
    this.actions.resize(rows, columns, cid);
  }
}
