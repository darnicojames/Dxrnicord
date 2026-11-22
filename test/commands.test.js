import assert from "node:assert/strict";
import test from "node:test";
import { commandLookup, commands, parsePrefixCommand } from "../src/commands/index.js";

test("all prefix commands have unique names, aliases, and execute functions", () => {
  assert.ok(commands.length >= 16, `Expected at least 16 commands, got ${commands.length}`);

  const seen = new Set();
  for (const cmd of commands) {
    assert.equal(typeof cmd.name, "string");
    assert.equal(typeof cmd.execute, "function", `Command ${cmd.name} missing execute()`);
    assert.ok(!seen.has(cmd.name), `Duplicate command name: ${cmd.name}`);
    seen.add(cmd.name);

    for (const alias of cmd.aliases || []) {
      assert.ok(!seen.has(alias), `Duplicate alias: ${alias}`);
      seen.add(alias);
      assert.equal(commandLookup.get(alias), cmd);
    }
  }
});

test("parsePrefixCommand parses d! commands case-insensitively and ignores other messages", () => {
  assert.deepEqual(parsePrefixCommand("d!play blinding lights", "d!"), {
    name: "play",
    args: ["blinding", "lights"],
  });
  assert.deepEqual(parsePrefixCommand("D!P https://open.spotify.com/track/123", "d!"), {
    name: "p",
    args: ["https://open.spotify.com/track/123"],
  });
  assert.equal(parsePrefixCommand("/play song", "d!"), null);
  assert.equal(parsePrefixCommand("hello world", "d!"), null);
  assert.equal(parsePrefixCommand("d!   ", "d!"), null);
});
