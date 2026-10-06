"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { deletionEntry } = require("./protocol.cjs");
const AGE = 30 * 24 * 60 * 60 * 1000;

class RecentDeletions {
  #entries = [];
  #pending = Promise.resolve();

  constructor(filename, now = Date.now) {
    this.filename = filename;
    this.now = now;
  }

  static async open(filename, now) {
    const store = new RecentDeletions(filename, now);
    try {
      if ((await fs.stat(filename)).size > 32 * 1024 * 1024) return store;
      const data = JSON.parse(await fs.readFile(filename, "utf8"));
      if (data.version === 1 && Array.isArray(data.entries)) {
        const seen = new Set();
        for (const value of data.entries) {
          try {
            const entry = deletionEntry(value);
            if (!seen.has(entry.id)) store.#entries.push(entry);
            seen.add(entry.id);
          } catch {
            // An invalid entry cannot authorize a restore.
          }
        }
      }
    } catch {
      // Missing or invalid history starts empty.
    }
    store.#trim();
    return store;
  }

  #trim() {
    const now = this.now();
    this.#entries = this.#entries
      .filter((entry) => entry.deletedAt > now - AGE && entry.deletedAt <= now)
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .slice(0, 200);
  }

  list(hosts) {
    this.#trim();
    return structuredClone(
      this.#entries.filter((entry) => !hosts || hosts.includes(entry.host)),
    );
  }

  add(value) {
    const entry = deletionEntry({
      ...value,
      id: randomUUID(),
      deletedAt: this.now(),
    });
    return this.#write(() => {
      this.#entries.unshift(entry);
    }).then(() => entry);
  }

  remove(id) {
    return this.#write(() => {
      this.#entries = this.#entries.filter((entry) => entry.id !== id);
    });
  }

  #write(update) {
    const save = async () => {
      update();
      this.#trim();
      if (!this.filename) return;
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.filename), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(
          temporary,
          JSON.stringify({ version: 1, entries: this.#entries }),
          { mode: 0o600, flag: "wx" },
        );
        await fs.rename(temporary, this.filename);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    };
    this.#pending = this.#pending.then(save, save);
    return this.#pending;
  }
}

module.exports = { RecentDeletions };
