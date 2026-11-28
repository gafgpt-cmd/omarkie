// Nueva edición, page side: the fold runs in a worker; each change renders as the new text with
// its new words in <ins> and the old words it replaced in <del> right where they stood.
import type { Edition } from "../../../shared/fold-edition.mjs";
import { morphPlan } from "../../../shared/fold-morph.mjs";
import type { FoldPin } from "../../../shared/fold-units.mjs";
import { renderMarkdown } from "../../editor/markdown";
import { scan } from "./morph";
// Inline (a blob worker): the desktop page loads from file://, where a module worker URL cannot start.
import EditionWorker from "./edition.worker?worker&inline";

interface Job { resolve(edition: Edition): void; reject(error: Error): void }
type Reply = { id: number; edition: Edition; error?: undefined } | { id: number; error: string };

let worker: Worker | null = null, sequence = 0;
const jobs = new Map<number, Job>();

function thread() {
  if (worker) return worker;
  const next = new EditionWorker();
  next.onmessage = ({ data }: MessageEvent<Reply>) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.error !== undefined) job.reject(new Error(data.error)); else job.resolve(data.edition);
  };
  next.onerror = event => {
    for (const job of jobs.values()) job.reject(new Error(event.message));
    jobs.clear(); next.terminate(); worker = null;
  };
  return worker = next;
}

export function compareEditions(old: string, next: string, pins: FoldPin[]): Promise<Edition> {
  const target = thread(), id = ++sequence, { promise, resolve, reject } = Promise.withResolvers<Edition>();
  jobs.set(id, { resolve, reject });
  target.postMessage({ id, old, next, pins });
  return promise;
}

function rendered(markdown: string, documentId: string) {
  const template = document.createElement("template");
  template.innerHTML = markdown ? renderMarkdown(markdown, documentId) : "";
  return template.content;
}

/** `next` as rendered Markdown, its words not in `old` inside <ins>, and old words with no place in `next` as <del> after the word they followed. */
export function diffHtml(next: string, old: string, documentId: string) {
  const after = rendered(next, documentId), before = rendered(old, documentId);
  const fresh = scan(after, true), gone = scan(before, false), plan = morphPlan(fresh.keys, gone.keys);
  fresh.nodes.forEach((node, index) => {
    if (plan.kept[index]) return;
    const ins = document.createElement("ins");
    node.replaceWith(ins); ins.append(node);
  });
  // A run of new words reads as one insertion: fold the spaces between them in.
  for (const ins of [...after.querySelectorAll("ins")]) {
    if (!ins.isConnected) continue;
    let space = ins.nextSibling;
    while (space?.nodeType === Node.TEXT_NODE && !/\S/.test(space.nodeValue ?? "") && space.nextSibling instanceof Element && space.nextSibling.localName === "ins") {
      const following = space.nextSibling;
      ins.append(space, ...following.childNodes);
      following.remove();
      space = ins.nextSibling;
    }
  }
  const outer = (node: Element) => node.closest("ins") ?? node;
  for (let at = 0; at < plan.added.length;) {
    const anchor = plan.added[at].after, del = document.createElement("del");
    for (; at < plan.added.length && plan.added[at].after === anchor; at++) {
      const atom = gone.atoms.get(gone.keys.indexOf(plan.added[at].token));
      if (del.childNodes.length) del.append(" ");
      del.append(atom ? atom.cloneNode(true) : plan.added[at].token);
    }
    if (anchor >= 0) outer(fresh.nodes[anchor]).after(" ", del);
    else if (fresh.nodes.length) outer(fresh.nodes[0]).before(del, " ");
    else { const paragraph = document.createElement("p"); paragraph.append(del); after.append(paragraph); }
  }
  // Words go back to plain text: the markup only needs the <ins> and <del> runs.
  for (const node of fresh.nodes) {
    if (node.classList.contains("fold-atom")) node.classList.remove("fold-w", "fold-atom");
    else node.replaceWith(...node.childNodes);
  }
  const box = document.createElement("div");
  box.append(after);
  return box.innerHTML;
}
