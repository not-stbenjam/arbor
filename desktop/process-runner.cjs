"use strict";

const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { progressEvent } = require("./protocol.cjs");

const MAX_OUTPUT = 64 * 1024 * 1024;
const PROGRESS_PREFIX = "@arbor-progress ";
const MAX_PROGRESS_LINE = 65536;

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
    onProgress,
    signal,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    onChild(child);
    let stdout = [],
      stderr = [],
      size = 0,
      failure,
      settled = false,
      forceTimer;
    const decoder = new StringDecoder("utf8");
    let pendingStderr = "",
      oversizedLine = false;
    const stderrLine = (line) => {
      if (
        onProgress &&
        line.length <= MAX_PROGRESS_LINE &&
        line.startsWith(PROGRESS_PREFIX)
      ) {
        try {
          const event = progressEvent(
            JSON.parse(line.slice(PROGRESS_PREFIX.length)),
          );
          if (event) {
            onProgress(event);
            return;
          }
        } catch {
          /* Preserve malformed protocol data as diagnostic output. */
        }
      }
      stderr.push(Buffer.from(line));
    };
    const consumeStderr = (chunk, end = false) => {
      pendingStderr += end ? decoder.end() : decoder.write(chunk);
      let newline;
      while ((newline = pendingStderr.indexOf("\n")) !== -1) {
        const line = pendingStderr.slice(0, newline + 1);
        if (oversizedLine) stderr.push(Buffer.from(line));
        else stderrLine(line);
        pendingStderr = pendingStderr.slice(newline + 1);
        oversizedLine = false;
      }
      if (pendingStderr.length > MAX_PROGRESS_LINE || end) {
        if (end && !oversizedLine && pendingStderr.length <= MAX_PROGRESS_LINE)
          stderrLine(pendingStderr);
        else stderr.push(Buffer.from(pendingStderr));
        pendingStderr = "";
        oversizedLine = !end;
      }
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      const kill = (name) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, name);
          else child.kill(name);
        } catch (error) {
          if (error.code !== "ESRCH") child.kill(name);
        }
      };
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 2000);
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
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        stop(new Error("Arbor output exceeded its size limit"));
        return;
      }
      consumeStderr(chunk);
    });
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      onDone(child);
      error ? reject(error) : resolve(output);
    };
    child.once("error", (error) =>
      finish(new Error(`Cannot start Arbor CLI: ${error.message}`)),
    );
    child.once("close", (code, signal) => {
      consumeStderr(null, true);
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (failure) return finish(failure);
      if (code !== 0)
        return finish(
          new Error(detail || `Arbor CLI exited ${signal || code}`),
        );
      finish(null, Buffer.concat(stdout).toString("utf8"));
    });
    const abort = () => stop(new Error("Arbor scan stopped"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

module.exports = { execute, childEnvironment };
