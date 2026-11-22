import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, parseBool, parseClampedInt, parseCustomNodes } from "../src/config.js";

test("parseBool handles truthy, falsy, and fallback values", () => {
  assert.equal(parseBool("true", false), true);
  assert.equal(parseBool("1", false), true);
  assert.equal(parseBool("yes", false), true);
  assert.equal(parseBool("false", true), false);
  assert.equal(parseBool("0", true), false);
  assert.equal(parseBool("", true), true);
  assert.equal(parseBool(undefined, false), false);
});

test("parseClampedInt clamps within range", () => {
  assert.equal(parseClampedInt("250", 80, 1, 150), 150);
  assert.equal(parseClampedInt("-5", 80, 1, 150), 1);
  assert.equal(parseClampedInt("100", 80, 1, 150), 100);
  assert.equal(parseClampedInt("abc", 80, 1, 150), 80);
});

test("loadConfig defaults to autoPublicNodes=true when no custom nodes are configured", () => {
  const cfg = loadConfig({ DISCORD_TOKEN: "tok123" });
  assert.equal(cfg.discordToken, "tok123");
  assert.equal(cfg.customNodes.length, 0);
  assert.equal(cfg.autoPublicNodes, true);
  assert.equal(cfg.defaultSearchPlatform, "ytmsearch");
  assert.equal(cfg.defaultVolume, 80);
  assert.equal(cfg.idleLeaveSeconds, 120);
  assert.equal(cfg.healthPort, null);
});

test("loadConfig parses single custom node and disables autoPublicNodes by default", () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: "tok",
    LAVALINK_HOST: "lavalink.local",
    LAVALINK_PORT: "2333",
    LAVALINK_PASSWORD: "secret",
    LAVALINK_SECURE: "false",
    PORT: "8080",
  });
  assert.equal(cfg.customNodes.length, 1);
  assert.deepEqual(cfg.customNodes[0], {
    id: "primary-node",
    host: "lavalink.local",
    port: 2333,
    authorization: "secret",
    secure: false,
  });
  assert.equal(cfg.autoPublicNodes, false);
  assert.equal(cfg.healthPort, 8080);
});

test("parseCustomNodes parses LAVALINK_NODES JSON array", () => {
  const nodes = parseCustomNodes({
    LAVALINK_NODES: JSON.stringify([
      { id: "n1", host: "a.example.com", port: 443, password: "p1", secure: true },
      { host: "b.example.com", authorization: "p2" },
    ]),
  });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].authorization, "p1");
  assert.equal(nodes[0].secure, true);
  assert.equal(nodes[1].id, "custom-node-2");
  assert.equal(nodes[1].port, 2333);
});
