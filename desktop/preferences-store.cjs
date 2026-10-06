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
    return this.#write((current) => {
      const hosts = editable.hosts.map((host) => {
        const saved = current.hosts.find((entry) => entry.host === host.host);
        // Editing a name/theme must not restore an older scan destination.
        // Existing host roots, like local root history, belong to saveScan.
        return saved ? { ...host, root: saved.root } : host;
      });
      const retained = new Set(hosts.map((host) => host.host));
      const removed = new Set(
        current.hosts
          .filter((host) => !retained.has(host.host))
          .map((host) => host.host),
      );
      const scans = current.scans.filter((scan) => !removed.has(scan.host));
      // Forgetting the selected host must not resurrect it from last-scan
      // launch preferences on restart. Other editable fields cannot replace
      // canonical per-host choices with an older settings form snapshot.
      const scan = removed.has(current.scan.host)
        ? scans.find((scan) => scan.host === "") ||
          scanOptions({ root: current.roots[0] || "" })
        : current.scan;
      return { ...current, theme: editable.theme, hosts, scans, scan };
    });
  }

  saveView(value) {
    return this.#write((current) => ({
      ...current,
      ...Object.fromEntries(
        ["sort", "descending", "hostFilter"]
          .filter((key) => Object.hasOwn(value, key))
          .map((key) => [key, value[key]]),
      ),
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
        scans: [
          ...current.scans.filter((scan) => scan.host !== options.host),
          options,
        ],
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
