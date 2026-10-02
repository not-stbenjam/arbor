"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const os = require("node:os");

const MAX_OUTPUT = 64 * 1024 * 1024;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*$/;

function text(value, name, limit = 4096) {
  if (typeof value !== "string" || value.length > limit || value.includes("\0"))
    throw new Error(`Invalid ${name}`);
  return value;
}

function scanOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid scan options");
  const host = text(value.host ?? "", "SSH host", 255);
  if (host && !HOST.test(host))
    throw new Error("Use an SSH host alias or user@hostname");
  return {
    root: text(value.root ?? "", "scan folder"),
    host,
    github: value.github === true,
    fetch: value.fetch === true,
  };
}

function childEnvironment(platform = process.platform) {
  const env = { ...process.env };
  if (platform === "darwin")
    env.PATH = `${env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return env;
}

function execute(
  binary,
  args,
  {
    env = childEnvironment(),
    timeout = 20 * 60 * 1000,
    onChild = () => {},
    onDone = () => {},
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    onChild(child);
    let stdout = [],
      stderr = [],
      size = 0,
      failure,
      settled = false,
      forceTimer;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      forceTimer.unref();
    };
    const timer = setTimeout(
      () => stop(new Error("Arbor operation timed out")),
      timeout,
    );
    timer.unref();
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        stop(new Error("Arbor output exceeded its size limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      onDone(child);
      error ? reject(error) : resolve(output);
    };
    child.once("error", (error) =>
      finish(new Error(`Cannot start Arbor CLI: ${error.message}`)),
    );
    child.once("close", (code, signal) => {
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (failure) return finish(failure);
      if (code !== 0)
        return finish(
          new Error(detail || `Arbor CLI exited ${signal || code}`),
        );
      finish(null, Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function parseReport(raw) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error("Arbor CLI returned invalid JSON");
  }
  if (
    !report ||
    typeof report.root !== "string" ||
    !Array.isArray(report.worktrees) ||
    !Array.isArray(report.warnings)
  )
    throw new Error("Arbor CLI returned an incomplete scan");
  const ids = new Set();
  for (const w of report.worktrees) {
    if (
      !w ||
      typeof w.id !== "string" ||
      !w.id ||
      ids.has(w.id) ||
      typeof w.path !== "string" ||
      typeof w.head !== "string" ||
      typeof w.branch !== "string"
    )
      throw new Error("Arbor CLI returned invalid worktree metadata");
    ids.add(w.id);
  }
  return report;
}

class Backend {
  constructor({
    binary,
    version = "dev",
    platform = process.platform,
    githubAvailable = false,
    run,
    root = "",
    host = "",
  }) {
    this.children = new Set();
    this.operation = null;
    this.options = scanOptions({ root, host });
    this.state = {
      report: null,
      busy: false,
      error: "",
      root,
      host,
      version,
      revision: null,
      githubAvailable,
      platform,
    };
    this.run =
      run ||
      ((args) =>
        execute(binary, args, {
          env: childEnvironment(platform),
          onChild: (c) => this.children.add(c),
          onDone: (c) => this.children.delete(c),
        }));
    this.pending = Promise.resolve();
    this.disposed = false;
  }

  getState() {
    return structuredClone(this.state);
  }

  async readReport(options) {
    const args = [
      "list",
      "--json",
      "--path",
      options.root || (options.host ? "~" : os.homedir()),
    ];
    if (options.host) args.push("--host", options.host);
    if (options.github) args.push("--github");
    if (options.fetch) args.push("--fetch");
    return parseReport(await this.run(args));
  }

  scan(value = {}) {
    if (this.disposed) throw new Error("Arbor is closing");
    if (this.state.busy) throw new Error("An operation is already running");
    this.options = scanOptions(value);
    Object.assign(this.state, {
      report: null,
      busy: true,
      error: "",
      root: this.options.root,
      host: this.options.host,
      revision: null,
    });
    this.operation = "scan";
    const options = { ...this.options };
    this.pending = this.readReport(options)
      .then((report) => {
        if (this.disposed) return;
        Object.assign(this.state, {
          report,
          root: report.root,
          revision: randomUUID(),
        });
      })
      .catch((error) => {
        if (!this.disposed) this.state.error = error.message;
      })
      .finally(() => {
        this.state.busy = false;
        this.operation = null;
      });
    return this.getState();
  }

  async remove(value, confirm) {
    if (this.disposed) throw new Error("Arbor is closing");
    if (this.state.busy) throw new Error("An operation is already running");
    if (
      !value ||
      typeof value !== "object" ||
      !this.state.revision ||
      value.revision !== this.state.revision
    )
      throw new Error(
        "The scan changed; review the current worktrees and try again",
      );
    if (
      !Array.isArray(value.items) ||
      !value.items.length ||
      value.items.length > 1000
    )
      throw new Error("Choose between 1 and 1000 worktrees");
    const selected = [],
      seen = new Set();
    for (const item of value.items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.head !== "string" ||
        seen.has(item.id)
      )
        throw new Error("Invalid worktree selection");
      const w = this.state.report.worktrees.find(
        (entry) => entry.id === item.id,
      );
      if (!w || w.head !== item.head || !w.canRemove || w.outsideRoot)
        throw new Error("Worktree changed or is protected; scan again");
      if (value.recommendedOnly === true && !w.recommended)
        throw new Error("Worktree is not a cleanup recommendation");
      selected.push(structuredClone(w));
      seen.add(item.id);
    }
    this.state.busy = true;
    this.state.error = "";
    this.operation = "remove";
    const options = { ...this.options },
      results = [];
    const perform = async () => {
      try {
        const manual = selected.filter((w) => !w.recommended);
        if (manual.length && (!confirm || !(await confirm(manual))))
          return {
            cancelled: true,
            results,
            report: this.state.report,
            revision: this.state.revision,
          };
        this.state.revision = null;
        for (const w of selected) {
          const args = [
            "remove",
            "--yes",
            "--json",
            "--head",
            w.head,
            "--id",
            w.id,
            "--branch",
            w.branch,
          ];
          if (options.host) args.push("--host", options.host);
          if (w.pr?.merged) args.push("--github");
          if (value.recommendedOnly === true || w.recommended)
            args.push("--recommended-only");
          args.push("--", w.path);
          try {
            const result = JSON.parse(await this.run(args));
            if (!result || result.path !== w.path || result.removed !== true)
              throw new Error(result?.error || "Arbor did not confirm removal");
            results.push({ path: w.path, removed: true });
          } catch (error) {
            results.push({
              path: w.path,
              removed: false,
              error: error.message,
            });
          }
        }
        try {
          const report = await this.readReport({ ...options, fetch: false });
          Object.assign(this.state, {
            report,
            root: report.root,
            revision: randomUUID(),
          });
        } catch (error) {
          this.state.error = `Cleanup finished, but refreshing failed: ${error.message}`;
        }
        return {
          results,
          report: structuredClone(this.state.report),
          revision: this.state.revision,
          error: this.state.error,
        };
      } finally {
        this.state.busy = false;
        this.operation = null;
      }
    };
    this.pending = perform();
    return this.pending;
  }

  dispose() {
    if (this.operation === "remove") return false;
    this.disposed = true;
    for (const child of this.children) child.kill("SIGTERM");
    return true;
  }
}

function validatePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preferences");
  const theme = value.theme ?? "system";
  if (!["system", "light", "dark"].includes(theme))
    throw new Error("Invalid theme");
  if (!Array.isArray(value.hosts ?? []) || (value.hosts?.length ?? 0) > 100)
    throw new Error("Invalid saved hosts");
  const hosts = (value.hosts ?? []).map((item) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid saved host");
    const host = scanOptions({ host: item.host }).host;
    if (!host) throw new Error("Saved SSH host cannot be empty");
    return {
      name: text(item.name || host, "host name", 100),
      host,
      root: text(item.root ?? "~", "remote folder"),
    };
  });
  const roots = value.roots ?? [];
  if (!Array.isArray(roots) || roots.length > 100)
    throw new Error("Invalid recent folders");
  return {
    theme,
    hosts,
    roots: roots.map((root) => text(root, "recent folder")),
  };
}

module.exports = {
  Backend,
  execute,
  parseReport,
  scanOptions,
  validatePreferences,
  childEnvironment,
};
