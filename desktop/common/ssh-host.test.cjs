"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidSSHHost, MAX_HOST_LENGTH } = require("./ssh-host.mjs");
const cases = require("../../testdata/ssh-hosts.json");

test("desktop SSH grammar matches the shared Go contract cases", () => {
  for (const { host, valid } of cases) {
    assert.equal(
      isValidSSHHost(host, { allowLocal: true }),
      valid,
      JSON.stringify(host),
    );
    assert.equal(
      isValidSSHHost(host),
      host !== "" && valid,
      JSON.stringify(host),
    );
  }
  assert.equal(MAX_HOST_LENGTH, 255);
  assert.equal(isValidSSHHost("a".repeat(255)), true);
  assert.equal(isValidSSHHost("a".repeat(256)), false);
});
