// Agent route of the Fold (design §4.5): chunks wait here as jobs until a local agent session claims one with
// `omarkie-axi fold poll` and answers with `omarkie-axi fold reply`. The agent runs under its own login; no key
// passes through here. A cancelled job leaves at once, so its call slot is free for the next chunk.

import { randomBytes } from "node:crypto";
import { FOLD_REPLY_BYTES, foldInstruction, foldJob, foldReplyObject, ladderReplyProblems } from "../shared/fold-prompt.mjs";

const abortError = () => Object.assign(new Error("Fold run cancelled."), { name: "AbortError", code: "FOLD_CANCELLED" });
const idPattern = /^[a-f0-9]{12}$/;

export class FoldBridge {
  /**
   * @param {object} [options]
   * @param {number} [options.claimTimeout] ms a job waits for an agent before it fails as "no agent".
   * @param {number} [options.replyTimeout] ms a claimed job waits for its reply.
   * @param {number} [options.waitTimeout] ms `poll --wait` holds before it answers "no job".
   */
  constructor({ claimTimeout = 120_000, replyTimeout = 600_000, waitTimeout = 80_000, id = () => randomBytes(6).toString("hex") } = {}) {
    Object.assign(this, { claimTimeout, replyTimeout, waitTimeout, id });
    this.jobs = new Map();
    this.waiters = new Map();
  }

  /** Queues one chunk for an agent; settles with the reply object, or rejects on cancel, timeout or close. */
  submit(request, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const job = { id: this.id(), request, agent: request.agent, state: "queued", owner: null, timer: null };
      const finish = (error, value) => {
        if (this.jobs.get(job.id) !== job) return;
        this.jobs.delete(job.id);
        clearTimeout(job.timer);
        signal?.removeEventListener("abort", cancel);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(abortError());
      job.finish = finish;
      job.timer = setTimeout(() => finish(Object.assign(new Error("No agent picked up the fold job."), { code: "FOLD_NO_AGENT" })), this.claimTimeout);
      signal?.addEventListener("abort", cancel, { once: true });
      this.jobs.set(job.id, job);
      this.#offer(job);
    });
  }

  /** Glass bridge entry for `op: "fold"` frames from the CLI. */
  client(request, send, waitId) {
    const action = request?.action;
    if (action === "home") return send({ jobs: [...this.jobs.values()].map(summary) });
    if (action === "poll") {
      const agent = request.agent ?? null;
      const job = this.#next(agent);
      if (job) return send({ job: this.#claim(job, request.owner) });
      if (request.wait !== true) return send({ job: null, queued: this.jobs.size });
      const timer = setTimeout(() => this.stopWait(waitId, true), this.waitTimeout);
      this.waiters.set(waitId, { agent, owner: request.owner, send, timer });
      return;
    }
    const job = typeof request?.id === "string" && idPattern.test(request.id) ? this.jobs.get(request.id) : null;
    if (action !== "view" && action !== "reply") return send({ error: "Unknown fold bridge request." });
    if (!job) return send({ error: `No fold job ${String(request?.id ?? "")}: it was answered, cancelled or timed out.`, code: "FOLD_JOB_GONE" });
    if (action === "view") return send({ job: wire(job) });
    if (job.state !== "claimed") return send({ error: "Claim the job with `omarkie-axi fold poll` before replying.", code: "FOLD_JOB_UNCLAIMED" });
    if (JSON.stringify(request.reply ?? null).length > FOLD_REPLY_BYTES) return send({ error: "The fold reply is larger than 512 KB.", code: "FOLD_REPLY_INVALID" });
    // A reply outside the contract goes back to the agent, which can fix it: the job stays claimed until a valid
    // reply or its reply timeout.
    const problems = ladderReplyProblems(request.reply, job.request.chunk.units);
    if (problems.length) {
      const more = problems.length > 5 ? `; and ${problems.length - 5} more` : "";
      return send({ error: `The fold reply breaks its contract: ${problems.slice(0, 5).join("; ")}${more}`, code: "FOLD_REPLY_INVALID", problems: problems.slice(0, 50) });
    }
    job.finish(null, foldReplyObject(request.reply));
    send({ id: job.id, status: "done" });
  }

  /** The CLI's socket closed (`timedOut` false) or its wait ran out (`timedOut` true: answer "no job"). */
  stopWait(waitId, timedOut) {
    const waiter = this.waiters.get(waitId);
    if (!waiter) return;
    this.waiters.delete(waitId);
    clearTimeout(waiter.timer);
    if (timedOut) waiter.send({ job: null, queued: this.jobs.size });
  }

  close() {
    for (const job of [...this.jobs.values()]) job.finish(Object.assign(new Error("Fold storage closed."), { code: "FOLD_CLOSED" }));
    for (const waitId of [...this.waiters.keys()]) this.stopWait(waitId, true);
  }

  #next(agent) {
    for (const job of this.jobs.values()) if (job.state === "queued" && (!agent || job.agent === agent)) return job;
    return null;
  }

  #claim(job, owner) {
    job.state = "claimed";
    job.owner = typeof owner === "string" && owner.trim() ? owner.trim().slice(0, 64) : "agent";
    clearTimeout(job.timer);
    job.timer = setTimeout(() => job.finish(Object.assign(new Error("The agent did not answer the fold job in time."), { code: "FOLD_AGENT_TIMEOUT" })), this.replyTimeout);
    return wire(job);
  }

  #offer(job) {
    for (const [waitId, waiter] of this.waiters) {
      if (waiter.agent && waiter.agent !== job.agent) continue;
      this.waiters.delete(waitId);
      clearTimeout(waiter.timer);
      waiter.send({ job: this.#claim(job, waiter.owner) });
      return;
    }
  }
}

function summary(job) {
  return { id: job.id, slot: job.request.slot, agent: job.agent, units: job.request.chunk.units.length, state: job.state };
}

function wire(job) {
  const { request } = job;
  return { id: job.id, slot: request.slot, agent: job.agent, model: request.model, outLang: request.outLang, state: job.state,
    instruction: foldInstruction(request), ...foldJob(request) };
}
