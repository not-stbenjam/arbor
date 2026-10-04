"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { MAX_HOST_LABEL_LENGTH } = require("./common/ssh-host.mjs");
const {
  validatePreferences,
  loadPreferences,
  scanOptions,
} = require("./protocol.cjs");

class PreferencesStore {
  #filename;
  #value = validatePreferences({});
  #pending = Promise.resolve();
  #onChange;

  constructor(filename, { onChange = () => {} } = {}) {
    this.#filename = filename;
    this.#onChange = onChange;
  }

  static async open(filename, options) {
    const store = new PreferencesStore(filename, options);
    try {
      store.#value = loadPreferences(
        JSON.parse(await fs.readFile(filename, "utf8")),
      );
    } catch {
      /* First launch or invalid preferences use schema defaults. */
    }
    return store;
  }

  get() {
    return structuredClone(this.#value);
  }

  saveEditable(value) {
    const editable = validatePreferences(value);
    return this.#write((current) => ({
      ...current,
      theme: editable.theme,
      hosts: editable.hosts,
      // Scan choices, setup completion, and recent local roots have one writer.
    }));
  }

  saveScan(value, { theme, setupCompleted = false } = {}) {
    const options = scanOptions(value);
    return this.#write((current) => {
      let hosts = current.hosts;
      if (options.host) {
        const known = hosts.some((host) => host.host === options.host);
        hosts = hosts.map((host) =>
          host.host === options.host ? { ...host, root: options.root } : host,
        );
        if (!known && setupCompleted)
          hosts = [
            ...hosts,
            {
              host: options.host,
              name: options.host.slice(0, MAX_HOST_LABEL_LENGTH),
              root: options.root,
            },
          ];
      }
      return {
        ...current,
        ...(theme !== undefined ? { theme } : {}),
        setupCompleted: current.setupCompleted || setupCompleted,
        scan: options,
        hosts,
        roots:
          !options.host && options.root
            ? [
                options.root,
                ...current.roots.filter((root) => root !== options.root),
              ].slice(0, 8)
            : current.roots,
      };
    });
  }

  reset() {
    return this.#write(() => validatePreferences({}));
  }

  #write(update) {
    const save = async () => {
      const next = validatePreferences(update(this.#value));
      const temporary = `${this.#filename}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.#filename), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temporary, this.#filename);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
      this.#value = next;
      this.#onChange(this.get());
      return this.get();
    };
    this.#pending = this.#pending.then(save, save);
    return this.#pending;
  }
}

module.exports = { PreferencesStore };
