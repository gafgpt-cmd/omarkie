const verbs = require("./tutor-verbs.json");
module.exports = function tutorBridge(makeId, notify, anchorFor, expiredAt) {
  const documents = new Map(), asks = new Map();
  const receipts = ["queued", "seen", "working", "done"];
  let listener;
  const fail = error => ({ error });
  const body = (value, max) => typeof value === "string" && value.length <= max && value.trim();
  const docPath = value => body(value, 4096) && !/[:\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && !part.startsWith("."));
  const agent = value => body(value, 60) && !/[\x00-\x1f\x7f]/.test(value);
  const view = ({ window: _, expires: __, target: ___, reply: ____, ...ask }) => ask;
  const summary = ({ id, verb, doc, block, status }) => ({ id, verb, doc, block, status });
  // A bubble adds its own neighbours; the curtain sends none. Both keep the ask small.
  const neighbours = value => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const ok = text => text === undefined || typeof text === "string" && text.length <= 4000;
    if (!ok(value.before) || !ok(value.after)) return null;
    return { ...(value.before === undefined ? {} : { before: value.before }), ...(value.after === undefined ? {} : { after: value.after }) };
  };
  const matches = (ask, doc) => !doc || ask.doc === doc;
  const receipt = ask => notify(ask.window, { type: "receipt", id: ask.id, status: ask.status, owner: ask.owner });
  function presence() {
    for (const [window, doc] of documents) {
      const active = Array.from(asks.values()).find(ask => ask.window === window && ask.status !== "done" && ask.owner)?.owner;
      notify(window, { type: "agent", owner: active || (listener && (!listener.doc || listener.doc === doc) ? listener.owner : null) });
    }
  }
  function finish(result, error) {
    if (!listener) return;
    const wait = listener;
    listener = undefined;
    wait.send(error ? fail(error) : { ask: result ? view(result) : null });
    presence();
  }
  function claim(doc, owner) {
    const pending = Array.from(asks.values()).find(ask => ask.status === "queued" && matches(ask, doc));
    if (!pending) return;
    pending.owner = owner; pending.status = "seen"; receipt(pending);
    return pending;
  }
  function clear(window) {
    for (const [id, ask] of asks) if (ask.window === window) asks.delete(id);
  }
  function expire(now) {
    for (const [id, ask] of asks) if (ask.expires <= now) {
      asks.delete(id);
      if (ask.status !== "done") notify(ask.window, { type: "expired", id });
    }
  }
  function bind(window, doc) {
    if (!docPath(doc)) return fail("Open a saved Markdown note in this vault.");
    if (documents.get(window) !== doc) clear(window);
    documents.set(window, doc); presence();
    return { ok: true };
  }
  function unbind(window) { documents.delete(window); clear(window); presence(); return documents.size; }
  function submit(window, { question, target, verb, context, origin } = {}) {
    expire(Date.now());
    const doc = documents.get(window);
    const around = neighbours(context);
    if (around === null) return fail("Send a short before and after neighbour.");
    if (!doc || !body(question, 1000) || typeof verb !== "string" || !(verb === "answer" || verb === "propose" || Object.hasOwn(verbs, verb)) || !target || !body(target.block, 24_000) ||
        !body(target.quote, 24_000) || !Array.isArray(target.headings) || target.headings.length > 6 ||
        target.headings.some(heading => typeof heading !== "string" || heading.length > 4096) ||
        !Number.isInteger(target.line) || target.line < 1 || target.line > 20_000_000) return fail("Select a paragraph and enter a question.");
    if (Array.from(asks.values()).some(ask => ask.window === window && ask.status !== "done")) return fail("Only one Tutor request at a time.");
    clear(window);
    const anchor = anchorFor(target);
    const ask = { id: makeId(), window, doc, block: anchor.hash, line: anchor.line, headings: anchor.headings, quote: anchor.quote,
      paragraph: target.block, question: question.trim(), verb, ...(Object.keys(around).length ? { context: around } : {}),
      ...(origin === "bubble" ? { origin: "bubble" } : {}), status: "queued", owner: null, expires: expiredAt() };
    asks.set(ask.id, ask); receipt(ask);
    if (listener && matches(ask, listener.doc)) finish(claim(listener.doc, listener.owner));
    return { id: ask.id };
  }
  function client(message, send, waitId) {
    expire(Date.now());
    if (!message || typeof message !== "object") return send(fail("Invalid bridge request."));
    const { op, doc, id } = message;
    if (doc !== undefined && !docPath(doc)) return send(fail("Use a vault-relative Markdown path."));
    if (op === "home") return send({ asks: Array.from(asks.values()).filter(ask => ask.status !== "done").map(summary) });
    if (op === "refresh") {
      for (const [window, current] of documents) if (current === doc) notify(window, { type: "refresh" });
      return send({ ok: true });
    }
    if (op === "poll") {
      if (!agent(message.owner)) return send(fail("Use a short listener name."));
      if (listener && message.takeover !== true) return send(fail("LISTENER_ACTIVE: run poll --takeover to replace the current listener."));
      if (listener) finish(null, "LISTENER_REPLACED");
      const result = claim(doc, message.owner);
      if (result || message.wait !== true) { presence(); return send({ ask: result ? view(result) : null }); }
      listener = { owner: message.owner, doc, send, waitId };
      presence(); return;
    }
    const ask = typeof id === "string" ? asks.get(id) : undefined;
    if (!ask) return send(fail("Ask not found in this vault."));
    if (op === "view") return send({ ask: view(ask) });
    if (ask.status === "queued" && (op === "status" || op === "reply")) return send(fail("Poll to claim the ask first."));
    if (op === "status") {
      const to = receipts.indexOf(message.status), from = receipts.indexOf(ask.status);
      if (to < 1) return send(fail("Use seen, working, or done."));
      if (message.status === "done" && ask.status !== "done") return send(fail("Use reply to mark the ask done."));
      if (from < to) { ask.status = message.status; receipt(ask); }
      return send({ status: ask.status });
    }
    if (op !== "reply" || !body(message.text, 64_000)) return send(fail("Supply a non-empty reply under 64,000 characters."));
    const reply = message.text.trim();
    if (ask.status === "done") return send(reply === ask.reply ? { status: "done" } : fail("This ask already has a reply."));
    ask.status = "done"; ask.reply = reply;
    notify(ask.window, { type: "reply", id: ask.id, owner: ask.owner, text: reply });
    presence();
    return send({ status: "done" });
  }
  function stopWait(waitId, timedOut) {
    if (!listener || listener.waitId !== waitId) return;
    if (timedOut) finish(null);
    else { listener = undefined; presence(); }
  }
  return { bind, unbind, submit, client, stopWait, clear, expire };
};
