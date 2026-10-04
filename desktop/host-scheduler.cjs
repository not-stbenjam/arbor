"use strict";

// Bounded per-host background work. A start callback resolves as soon as the
// host accepts its operation; the slot remains occupied until settle finishes.
class HostScheduler {
  #limit;
  #queued = new Map();
  #running = new Map();
  constructor(limit = 3) {
    this.#limit = limit;
  }
  queued(host) {
    return this.#queued.has(host);
  }
  schedule(host, start, settle, onError) {
    if (this.#queued.has(host)) return this.#queued.get(host).accepted;
    if (this.#running.has(host)) return this.#running.get(host).accepted;
    let resolve, reject;
    const accepted = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job = { accepted, start, settle, onError, resolve, reject };
    this.#queued.set(host, job);
    this.#pump();
    return accepted;
  }
  cancelQueued(host) {
    const job = this.#queued.get(host);
    if (job) {
      this.#queued.delete(host);
      job.resolve();
    }
  }
  cancelAllQueued() {
    for (const host of this.#queued.keys()) this.cancelQueued(host);
  }
  async waitForHost(host) {
    await this.#running.get(host)?.done;
  }
  #pump() {
    while (this.#running.size < this.#limit && this.#queued.size) {
      const [host, job] = this.#queued.entries().next().value;
      this.#queued.delete(host);
      this.#running.set(host, job);
      job.done = (async () => {
        try {
          job.resolve(await job.start());
          await job.settle();
        } catch (error) {
          job.onError(error);
          job.reject(error);
        } finally {
          this.#running.delete(host);
          this.#pump();
        }
      })();
    }
  }
  async waitUntilIdle() {
    while (this.#running.size || this.#queued.size) {
      await Promise.all([...this.#running.values()].map((job) => job.done));
    }
  }
}

module.exports = { HostScheduler };
