import assert from "node:assert/strict";
import test from "node:test";
import { NodeType } from "lavalink-client";
import {
  computeFrameStutterPenalty,
  extractProviderKey,
  fetchPublicNodeCandidates,
  getNodeFailedSources,
  getNodeLatency,
  getNodePenalty,
  isDaveCompatible,
  isNodeLinkInfo,
  isNodeSourceFailed,
  markNodeSourceFailed,
  normalizeSourceName,
  parseServerVersion,
  pickFastestConnectedNode,
  probeNode,
  recordNodeIssue,
  recordNodeLatency,
  resolveStartupNodes,
  scoreProbedNode,
  toLavalinkNodeOptions,
} from "../src/services/nodeDiscovery.js";
import { VoiceReadinessTracker } from "../src/utils/voiceReady.js";

test("parseServerVersion extracts semver numbers cleanly", () => {
  assert.deepEqual(parseServerVersion({ major: 4, minor: 2, patch: 1, semver: "4.2.1" }), {
    major: 4,
    minor: 2,
    patch: 1,
    semver: "4.2.1",
  });
  assert.deepEqual(parseServerVersion("4.2.0-beta.1"), {
    major: 4,
    minor: 2,
    patch: 0,
    semver: "4.2.0-beta.1",
  });
});

test("isDaveCompatible requires Lavalink >= 4.2.0 or NodeLink >= 3.0.0", () => {
  assert.equal(isDaveCompatible({ version: { major: 4, minor: 0, patch: 8, semver: "4.0.8" } }), false);
  assert.equal(isDaveCompatible({ version: { major: 4, minor: 1, patch: 5, semver: "4.1.5" } }), false);
  assert.equal(isDaveCompatible({ version: { major: 4, minor: 2, patch: 0, semver: "4.2.0" } }), true);
  assert.equal(isDaveCompatible({ version: { major: 4, minor: 3, patch: 0, semver: "4.3.0" } }), true);

  const nodeLink3 = { isNodelink: true, version: { major: 3, minor: 1, patch: 0, semver: "3.1.0" } };
  assert.equal(isNodeLinkInfo(nodeLink3), true);
  assert.equal(isDaveCompatible(nodeLink3), true);

  // 2026 master SNAPSHOT builds are DAVE-compatible; old 2024 snapshots are not
  assert.equal(
    isDaveCompatible({ version: { semver: "abc123-SNAPSHOT" }, buildTime: Date.UTC(2026, 4, 1) }),
    true,
  );
  assert.equal(
    isDaveCompatible({ version: { semver: "abc123-SNAPSHOT" }, buildTime: Date.UTC(2024, 5, 1) }),
    false,
  );
});

test("scoreProbedNode and pickFastestConnectedNode prefer low-latency healthy nodes", () => {
  const fastEu = {
    ok: true,
    daveCompatible: true,
    latencyMs: 40,
    node: { secure: true },
    sourceManagers: ["youtube", "deezer", "soundcloud"],
    stats: { cpu: { lavalinkLoad: 0.05 }, playingPlayers: 2 },
  };
  const slowOverloaded = {
    ok: true,
    daveCompatible: true,
    latencyMs: 2400,
    node: { secure: true },
    sourceManagers: ["youtube", "spotify", "deezer", "soundcloud"],
    stats: { cpu: { lavalinkLoad: 0.85 }, playingPlayers: 40 },
  };
  assert.ok(scoreProbedNode(fastEu) > scoreProbedNode(slowOverloaded));

  const nFast = {
    connected: true,
    heartBeatPing: 35,
    options: { id: "eu-fast" },
    info: { version: { major: 4, minor: 2, patch: 2 }, sourceManagers: ["youtube", "deezer"] },
    stats: { cpu: { lavalinkLoad: 0.05 }, playingPlayers: 1 },
  };
  const nSlow = {
    connected: true,
    heartBeatPing: 450,
    options: { id: "asia-slow" },
    info: { version: { major: 4, minor: 2, patch: 2 }, sourceManagers: ["youtube"] },
    stats: { cpu: { lavalinkLoad: 0.4 }, playingPlayers: 15 },
  };
  const fakeClient = { lavalink: { nodeManager: { nodes: new Map([["a", nSlow], ["b", nFast]]) } } };
  assert.equal(pickFastestConnectedNode(fakeClient).options.id, "eu-fast");

  // Recording stalls on eu-fast penalizes it so traffic shifts cleanly
  recordNodeIssue("eu-fast");
  recordNodeIssue("eu-fast");
  recordNodeIssue("eu-fast");
  assert.ok(getNodePenalty("eu-fast") >= 750);
  assert.equal(pickFastestConnectedNode(fakeClient).options.id, "asia-slow");
});

test("scoreProbedNode ranks DAVE-compatible rich nodes higher than legacy nodes", () => {
  const modern = {
    ok: true,
    daveCompatible: true,
    latencyMs: 90,
    node: { secure: true },
    sourceManagers: ["youtube", "spotify", "soundcloud"],
  };
  const legacy = {
    ok: true,
    daveCompatible: false,
    latencyMs: 20,
    node: { secure: true },
    sourceManagers: ["youtube", "spotify", "soundcloud"],
  };
  assert.ok(scoreProbedNode(modern) > scoreProbedNode(legacy));
});

test("probeNode parses /v4/info and identifies NodeLink vs Lavalink", async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: { major: 4, minor: 2, patch: 1, semver: "4.2.1" },
      jvm: "21.0.4",
      sourceManagers: ["youtube", "spotify", "soundcloud"],
      plugins: [{ name: "youtube-plugin" }, { name: "lavasrc-plugin" }],
    }),
  });

  const res = await probeNode(
    { id: "test", host: "lava.test", port: 443, authorization: "pw", secure: true },
    { fetchImpl: mockFetch },
  );

  assert.equal(res.ok, true);
  assert.equal(res.daveCompatible, true);
  assert.equal(res.nodeType, NodeType.Lavalink);
  assert.deepEqual(res.sourceManagers, ["youtube", "spotify", "soundcloud"]);
});

test("resolveStartupNodes selects healthy DAVE-compatible public nodes from directory", async () => {
  const mockFetch = async (url) => {
    if (url === "https://directory.test/All") {
      return {
        ok: true,
        json: async () => [
          {
            identifier: "old-v4",
            host: "old.example.com",
            port: 443,
            password: "pw",
            secure: true,
            version: "v4",
          },
          {
            identifier: "dave-v4",
            host: "dave.example.com",
            port: 443,
            password: "pw",
            secure: true,
            version: "v4",
          },
        ],
      };
    }
    if (url.includes("old.example.com")) {
      return {
        ok: true,
        json: async () => ({ version: { major: 4, minor: 0, patch: 8, semver: "4.0.8" }, sourceManagers: ["youtube"] }),
      };
    }
    if (url.includes("dave.example.com")) {
      return {
        ok: true,
        json: async () => ({
          version: { major: 4, minor: 2, patch: 2, semver: "4.2.2" },
          sourceManagers: ["youtube", "spotify", "soundcloud"],
        }),
      };
    }
    return { ok: false, status: 503 };
  };

  const nodes = await resolveStartupNodes(
    {
      customNodes: [],
      autoPublicNodes: true,
      publicNodesUrl: "https://directory.test/All",
      maxPublicNodes: 3,
    },
    { fetchImpl: mockFetch },
  );

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, "dave-v4");
  assert.equal(nodes[0].host, "dave.example.com");
});

test("computeFrameStutterPenalty penalizes nodes with deficit or nulled frames", () => {
  assert.equal(computeFrameStutterPenalty({ frameStats: { sent: 3000, deficit: 0, nulled: 0 } }), 0);
  assert.ok(computeFrameStutterPenalty({ frameStats: { sent: 2800, deficit: 150, nulled: 50 } }) >= 600);
});

test("VoiceReadinessTracker waits for VOICE_SERVER_UPDATE relay and returns immediately once ready", async () => {
  const tracker = new VoiceReadinessTracker({ settleMs: 10, timeoutMs: 500 });
  let connectCalls = 0;
  const fakePlayer = {
    guildId: "g-voice",
    connected: false,
    connect: async () => {
      connectCalls += 1;
      setTimeout(() => {
        fakePlayer.connected = true;
        tracker.markVoiceRelayed("g-voice");
      }, 15);
    },
  };

  assert.equal(tracker.isReady("g-voice"), false);
  await tracker.connectAndWaitReady(fakePlayer);
  assert.equal(connectCalls, 1);
  assert.equal(tracker.isReady("g-voice"), true);

  // Second call returns immediately without re-connecting
  const t0 = Date.now();
  await tracker.connectAndWaitReady(fakePlayer);
  assert.equal(connectCalls, 1);
  assert.ok(Date.now() - t0 < 50);

  tracker.clear("g-voice");
  assert.equal(tracker.isReady("g-voice"), false);
});

test("extractProviderKey deduplicates subdomains/ports of the same host while keeping distinct providers", () => {
  assert.equal(extractProviderKey("lavalink.triniumhost.com"), "triniumhost.com");
  assert.equal(extractProviderKey("lavalink-v4.triniumhost.com"), "triniumhost.com");
  assert.equal(extractProviderKey("lava-v4.millohost.my.id"), "millohost.my.id");
  assert.equal(extractProviderKey("nodelink.gdjkhp.com"), "gdjkhp.com");
  assert.equal(extractProviderKey("157.254.192.15"), "157.254.192.15");
});

test("per-node failed source tracking works for Deezer, YouTube, and sourceName aliases", () => {
  assert.equal(normalizeSourceName("ytmusic"), "youtube");
  assert.equal(normalizeSourceName("deezerm"), "deezer");

  markNodeSourceFailed("node-dz-broken", "deezer");
  assert.equal(isNodeSourceFailed("node-dz-broken", "deezer"), true);
  assert.equal(isNodeSourceFailed("node-dz-broken", "deezerm"), true);
  assert.equal(isNodeSourceFailed("node-dz-broken", "youtube"), false);
  assert.ok(getNodeFailedSources("node-dz-broken").has("deezer"));
});

test("fetchPublicNodeCandidates keeps unknown-version NodeLink entries and drops legacy v3 / invalid SSL ports", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => [
      { identifier: "nl-ok", host: "nodelink.example.net", port: 443, password: "pw", secure: true, version: "unknown" },
      { identifier: "legacy-v3", host: "oldv3.example.net", port: 2333, password: "pw", secure: false, version: "v3" },
      { identifier: "bad-ssl", host: "badssl.example.net", port: 2333, password: "pw", secure: true, version: "v4" },
    ],
  });

  const list = await fetchPublicNodeCandidates("https://dir.test/All", { fetchImpl: mockFetch });
  const hosts = list.map((n) => n.host);
  assert.equal(hosts.includes("nodelink.example.net"), true);
  assert.equal(hosts.includes("oldv3.example.net"), false);
  assert.equal(hosts.includes("badssl.example.net"), false);
});

test("pickFastestConnectedNode respects excludeNodeIds for automatic cross-node failover", () => {
  const n1 = {
    connected: true,
    heartBeatPing: 30,
    options: { id: "primary-1" },
    info: { version: { major: 4, minor: 2, patch: 2 }, filters: ["equalizer", "timescale"] },
    stats: { cpu: { lavalinkLoad: 0.02 }, playingPlayers: 20 },
  };
  const n2 = {
    connected: true,
    heartBeatPing: 90,
    options: { id: "backup-2" },
    info: { version: { major: 4, minor: 2, patch: 2 }, filters: ["equalizer", "timescale"] },
    stats: { cpu: { lavalinkLoad: 0.05 }, playingPlayers: 15 },
  };
  const fakeClient = { lavalink: { nodeManager: { nodes: new Map([["1", n1], ["2", n2]]) } } };
  assert.equal(pickFastestConnectedNode(fakeClient).options.id, "primary-1");
  assert.equal(pickFastestConnectedNode(fakeClient, { excludeNodeIds: ["primary-1"] }).options.id, "backup-2");
});

test("toLavalinkNodeOptions disables false-positive WS ping killer and records warm RTT hints", () => {
  const opts = toLavalinkNodeOptions({
    id: "stable-node",
    host: "lava.example.com",
    port: 443,
    authorization: "pw",
    secure: true,
  });
  assert.equal(opts.heartBeatInterval, 0);
  assert.equal(opts.enablePingOnStatsCheck, true);
  assert.ok(opts.retryAmount >= 10);

  recordNodeLatency("stable-node", 48.6);
  assert.equal(getNodeLatency({ options: { id: "stable-node" }, heartBeatPing: 0 }), 49);
  assert.equal(getNodeLatency({ options: { id: "stable-node" }, heartBeatPing: 25 }), 25);
});
