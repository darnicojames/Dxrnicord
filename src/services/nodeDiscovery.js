import { NodeType } from "lavalink-client";

const DAVE_SNAPSHOT_CUTOFF_MS = Date.UTC(2026, 1, 1); // Feb 2026 when DAVE landed in Lavalink 4.2/master
const NODE_PENALTY_TTL_MS = 3 * 60 * 1000; // 3-minute decaying penalty after a stall/error
const SOURCE_FAIL_TTL_MS = 10 * 60 * 1000; // 10-minute backoff when a source fails on a node (e.g. broken Deezer ARL or YouTube IP block)

/** @type {Map<string, { count: number, expiresAt: number }>} */
const nodePenalties = new Map();

/** @type {Map<string, Map<string, number>>} */
const nodeFailedSources = new Map();

/**
 * Fallback seed list of well-known community DAVE-compatible Lavalink v4 / NodeLink v3 nodes
 * in case the live directory API is temporarily unavailable.
 */
export const FALLBACK_PUBLIC_NODES = [
  {
    id: "gdjkhp-nodelink-ssl",
    host: "nodelink.gdjkhp.com",
    port: 443,
    authorization: "youshallnotpass",
    secure: true,
  },
  {
    id: "jirayu-v4-ssl",
    host: "lavalink.jirayu.net",
    port: 443,
    authorization: "youshallnotpass",
    secure: true,
  },
  {
    id: "nazha-v4-ssl",
    host: "lavalink.nazha.online",
    port: 443,
    authorization: "nazhafreelava",
    secure: true,
  },
  {
    id: "millohost-v4-ssl",
    host: "lava-v4.millohost.my.id",
    port: 443,
    authorization: "https://discord.gg/mjS5J2K3ep",
    secure: true,
  },
  {
    id: "serenetia-v4-ssl",
    host: "lavalinkv4.serenetia.com",
    port: 443,
    authorization: "https://seretia.link/discord",
    secure: true,
  },
];

/**
 * Normalize Lavalink / NodeLink sourceName variants to a canonical source family.
 * @param {string | undefined} sourceName
 */
export function normalizeSourceName(sourceName) {
  const s = String(sourceName || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "ytmusic" || s === "youtubemusic" || s.includes("youtube")) return "youtube";
  if (s === "deezerm" || s.includes("deezer")) return "deezer";
  if (s.includes("soundcloud")) return "soundcloud";
  if (s.includes("spotify")) return "spotify";
  if (s.includes("apple")) return "applemusic";
  return s;
}

/**
 * Extract a provider/root domain key so duplicate ports or subdomains of the exact same
 * public server (e.g. lavalink.triniumhost.com:2333 & lavalink-v4.triniumhost.com:443)
 * don't waste multiple failover slots.
 * @param {string} host
 */
export function extractProviderKey(host) {
  const clean = String(host || "").trim().toLowerCase();
  if (!clean) return "";
  // IPv4 / IPv6 literals stay exact
  if (/^\d+(?:\.\d+){3}$/.test(clean) || clean.includes(":")) return clean;
  const parts = clean.split(".").filter(Boolean);
  if (parts.length <= 2) return clean;
  const multiPartTlds = new Set(["co.uk", "my.id", "eu.org", "com.br", "com.au", "co.jp", "net.au"]);
  const lastTwo = parts.slice(-2).join(".");
  if (multiPartTlds.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/**
 * Record a stall/playback error on a node so new players & failover prefer healthier nodes.
 * @param {string | undefined} nodeId
 */
export function recordNodeIssue(nodeId) {
  if (!nodeId) return;
  const now = Date.now();
  const existing = nodePenalties.get(nodeId);
  const count = existing && existing.expiresAt > now ? existing.count + 1 : 1;
  nodePenalties.set(nodeId, { count: Math.min(count, 6), expiresAt: now + NODE_PENALTY_TTL_MS });
}

/**
 * Return current penalty weight for a node (0 when healthy).
 * @param {string | undefined} nodeId
 */
export function getNodePenalty(nodeId) {
  if (!nodeId) return 0;
  const entry = nodePenalties.get(nodeId);
  if (!entry) return 0;
  if (Date.now() >= entry.expiresAt) {
    nodePenalties.delete(nodeId);
    return 0;
  }
  return entry.count * 350;
}

/**
 * Detect YouTube IP/bot/login block exceptions from Lavalink youtube-source plugin.
 * @param {string} message
 */
export function isYoutubeBotBlockError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("requires login") ||
    text.includes("confirm you're not a bot") ||
    text.includes("confirm you’re not a bot") ||
    text.includes("sign in to confirm") ||
    text.includes("all clients failed to load") ||
    text.includes("dev.lavalink.youtube")
  );
}

/**
 * Mark a specific source (e.g. "deezer", "youtube", "soundcloud") as failing on a node
 * so subsequent searches on that node automatically route around it for 10 minutes.
 * @param {string | undefined} nodeId
 * @param {string | undefined} sourceName
 */
export function markNodeSourceFailed(nodeId, sourceName) {
  const canonical = normalizeSourceName(sourceName);
  if (!nodeId || !canonical) return;
  let map = nodeFailedSources.get(nodeId);
  if (!map) {
    map = new Map();
    nodeFailedSources.set(nodeId, map);
  }
  map.set(canonical, Date.now() + SOURCE_FAIL_TTL_MS);
}

/**
 * Check whether a specific source is currently flagged as failing on this node.
 * @param {string | undefined} nodeId
 * @param {string | undefined} sourceName
 */
export function isNodeSourceFailed(nodeId, sourceName) {
  const canonical = normalizeSourceName(sourceName);
  if (!nodeId || !canonical) return false;
  const map = nodeFailedSources.get(nodeId);
  if (!map) return false;
  const expiresAt = map.get(canonical);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    map.delete(canonical);
    if (map.size === 0) nodeFailedSources.delete(nodeId);
    return false;
  }
  return true;
}

/**
 * Return the Set of currently failed canonical source names for a node.
 * @param {string | undefined} nodeId
 * @returns {Set<string>}
 */
export function getNodeFailedSources(nodeId) {
  const out = new Set();
  if (!nodeId) return out;
  const map = nodeFailedSources.get(nodeId);
  if (!map) return out;
  const now = Date.now();
  for (const [src, expiresAt] of map.entries()) {
    if (now >= expiresAt) {
      map.delete(src);
    } else {
      out.add(src);
    }
  }
  if (map.size === 0) nodeFailedSources.delete(nodeId);
  return out;
}

/**
 * Mark a node as having YouTube IP-blocked temporarily.
 * @param {string | undefined} nodeId
 */
export function markNodeYoutubeBlocked(nodeId) {
  markNodeSourceFailed(nodeId, "youtube");
}

/**
 * Check whether YouTube is currently flagged as bot-blocked on this node.
 * @param {string | undefined} nodeId
 */
export function isNodeYoutubeBlocked(nodeId) {
  return isNodeSourceFailed(nodeId, "youtube");
}

/**
 * Extract normalized server process CPU load across both Lavalink (`lavalinkLoad`) and NodeLink (`nodelinkLoad`).
 * @param {any} stats
 */
function getServerCpuLoad(stats) {
  return Number(stats?.cpu?.lavalinkLoad ?? stats?.cpu?.nodelinkLoad) || 0;
}

/**
 * Compute audio stutter penalty from Lavalink/NodeLink frameStats (deficit & nulled frames).
 * Handles both Lavalink per-minute rolling counters and NodeLink cumulative lifetime counters.
 * @param {any} stats
 */
export function computeFrameStutterPenalty(stats) {
  const fs = stats?.frameStats;
  if (!fs || typeof fs !== "object") return 0;
  const deficit = Math.max(0, Number(fs.deficit) || 0);
  const nulled = Math.max(0, Number(fs.nulled) || 0);
  const expected = Math.max(0, Number(fs.expected) || 0);

  // NodeLink reports cumulative lifetime frame totals (including paused/idle player ticks);
  // scale by ratio with a gentle cap instead of raw unnormalized lifetime counts.
  if (expected > 20_000 && stats?.cpu?.nodelinkLoad !== undefined) {
    const ratio = Math.min(1, deficit / expected);
    return Math.round(ratio * 120);
  }

  return Math.min(deficit * 4 + nulled * 2, 600);
}

/**
 * Check whether a node's /v4/info advertises full audio customization filters (EQ + timescale).
 * @param {any} info
 */
function hasFullAudioFilters(info) {
  const filters = Array.isArray(info?.filters)
    ? new Set(info.filters.map((f) => String(f).toLowerCase()))
    : null;
  if (!filters || filters.size === 0) return false;
  return filters.has("equalizer") && filters.has("timescale");
}

/**
 * Pick the fastest, lowest-load, healthiest connected Lavalink/NodeLink node.
 * Optionally exclude specific node IDs (used during automatic failover).
 * @param {import("discord.js").Client} client
 * @param {{ excludeNodeIds?: Iterable<string> }} [opts]
 */
export function pickFastestConnectedNode(client, { excludeNodeIds } = {}) {
  const excluded = excludeNodeIds ? new Set(excludeNodeIds) : null;
  const connected = [...(client?.lavalink?.nodeManager?.nodes?.values() || [])].filter(
    (n) => n.connected && (!excluded || !excluded.has(n.options?.id)),
  );
  if (connected.length === 0) return undefined;

  connected.sort((a, b) => {
    const scoreNode = (n) => {
      const id = n.options?.id;
      const ping = Number.isFinite(n.heartBeatPing) && n.heartBeatPing > 0 ? n.heartBeatPing : 350;
      const cpuLoad = getServerCpuLoad(n.stats);
      const players = Number(n.stats?.playingPlayers) || 0;
      const stutterPenalty = computeFrameStutterPenalty(n.stats);
      const davePenalty = n.info && !isDaveCompatible(n.info) ? 2000 : 0;
      const failedSourcesPenalty = getNodeFailedSources(id).size * 260;
      const filterBonus = hasFullAudioFilters(n.info) ? -60 : 0;
      const nodeLinkBonus = isNodeLinkInfo(n.info) ? -60 : 0;
      const cpuPenalty = cpuLoad * 400;
      // Only penalize active player count if CPU or frame health is under pressure
      const playerPenalty = cpuLoad >= 0.35 || stutterPenalty > 0 ? Math.min(players * 6, 180) : 0;
      const throttledSmallVpsPenalty = players <= 5 && cpuLoad >= 0.08 ? 110 : 0;

      return (
        ping +
        cpuPenalty +
        playerPenalty +
        throttledSmallVpsPenalty +
        stutterPenalty +
        davePenalty +
        failedSourcesPenalty +
        filterBonus +
        nodeLinkBonus +
        getNodePenalty(id)
      );
    };
    return scoreNode(a) - scoreNode(b);
  });

  return connected[0];
}

/**
 * Parse major.minor.patch from either Lavalink's version object or semver string.
 * @param {any} version
 * @returns {{ major: number, minor: number, patch: number, semver: string }}
 */
export function parseServerVersion(version) {
  if (!version) {
    return { major: 0, minor: 0, patch: 0, semver: "unknown" };
  }
  const semver = String(version.semver || version || "").trim();
  const numericMatch = semver.match(/(\d+)\.(\d+)(?:\.(\d+))?/);

  const major =
    typeof version.major === "number"
      ? version.major
      : numericMatch
        ? Number.parseInt(numericMatch[1], 10)
        : 0;
  const minor =
    typeof version.minor === "number"
      ? version.minor
      : numericMatch
        ? Number.parseInt(numericMatch[2], 10)
        : 0;
  const patch =
    typeof version.patch === "number"
      ? version.patch
      : numericMatch && numericMatch[3]
        ? Number.parseInt(numericMatch[3], 10)
        : 0;

  return {
    major,
    minor,
    patch,
    semver: semver || `${major}.${minor}.${patch}`,
  };
}

/**
 * Detect whether a /v4/info payload belongs to NodeLink (a Node.js Lavalink v4 implementation).
 * @param {any} info
 * @returns {boolean}
 */
export function isNodeLinkInfo(info) {
  if (!info || typeof info !== "object") return false;
  if (info.isNodelink === true) return true;
  const jvm = String(info.jvm || "").toLowerCase();
  const semver = String(info.version?.semver || "").toLowerCase();
  return jvm.includes("node") || semver.includes("nodelink");
}

/**
 * Discord made DAVE (End-to-End Voice Encryption) mandatory in 2026.
 * Lavalink v4.2.0+, 2026 master SNAPSHOT builds, and NodeLink v3+ support DAVE.
 *
 * @param {any} info - Response JSON from GET /v4/info
 * @returns {boolean}
 */
export function isDaveCompatible(info) {
  if (!info || typeof info !== "object") return false;
  const parsed = parseServerVersion(info.version);

  if (isNodeLinkInfo(info)) {
    if (parsed.major >= 3) return true;
    if (info.dave === true || info.voiceEncryption === "dave") return true;
    return false;
  }

  // Standard Lavalink v4.2.0+
  if (parsed.major > 4 || (parsed.major === 4 && parsed.minor >= 2)) {
    return true;
  }

  // Modern 2026 git-hash -SNAPSHOT builds built from Lavalink v4 master
  if (
    parsed.semver.toUpperCase().includes("SNAPSHOT") &&
    typeof info.buildTime === "number" &&
    info.buildTime >= DAVE_SNAPSHOT_CUTOFF_MS
  ) {
    return true;
  }

  return false;
}

/**
 * Probe a candidate Lavalink v4 node via GET /v4/info + GET /v4/stats in parallel
 * to measure true latency, CPU load, and active stream count.
 *
 * @param {{ id: string, host: string, port: number, authorization: string, secure: boolean }} node
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function probeNode(node, { fetchImpl = fetch, timeoutMs = 3500 } = {}) {
  const protocol = node.secure ? "https" : "http";
  const baseUrl = `${protocol}://${node.host}:${node.port}`;
  const headers = {
    Authorization: node.authorization,
    Accept: "application/json",
    "User-Agent": "DiscordMusicBot/1.0",
  };
  const startedAt = Date.now();

  try {
    // 1. Fetch /v4/info (warms DNS + TCP + TLS connection)
    const res = await fetchImpl(`${baseUrl}/v4/info`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const coldMs = Date.now() - startedAt;

    if (!res.ok) {
      return { node, ok: false, reason: `HTTP ${res.status}`, latencyMs: coldMs };
    }

    const info = await res.json();

    // 2. Measure true warm keep-alive RTT via /v4/stats (removes cold TLS handshake noise!)
    let stats = null;
    let latencyMs = coldMs;
    try {
      const warmStart = Date.now();
      const statsRes = await fetchImpl(`${baseUrl}/v4/stats`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.min(timeoutMs, 2500)),
      });
      if (statsRes && statsRes.ok) {
        latencyMs = Date.now() - warmStart;
        stats = await statsRes.json();
      }
    } catch {
      // Fall back to cold latency if /v4/stats is unavailable
    }

    const version = parseServerVersion(info.version);
    const nodeLink = isNodeLinkInfo(info);
    const daveCompatible = isDaveCompatible(info);
    const sourceManagers = Array.isArray(info.sourceManagers)
      ? info.sourceManagers.map((s) => String(s).toLowerCase())
      : [];
    const plugins = Array.isArray(info.plugins)
      ? info.plugins.map((p) => String(p?.name || "").toLowerCase()).filter(Boolean)
      : [];

    return {
      node,
      ok: true,
      latencyMs,
      version,
      nodeType: nodeLink ? NodeType.NodeLink : NodeType.Lavalink,
      daveCompatible,
      sourceManagers,
      plugins,
      stats,
      info,
    };
  } catch (err) {
    return {
      node,
      ok: false,
      reason: err?.name === "TimeoutError" ? "Timeout" : err?.message || "Unreachable",
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Rank healthy nodes strongly prioritizing DAVE compatibility, LOW LATENCY,
 * full EQ/filter support, proven stability (0 frame deficit), and core music sources.
 *
 * @param {Awaited<ReturnType<typeof probeNode>>} probe
 * @returns {number}
 */
export function scoreProbedNode(probe) {
  if (!probe.ok) return -Infinity;

  let score = 0;
  if (probe.daveCompatible) score += 1000;
  if (probe.node.secure) score += 20;

  const sources = new Set(probe.sourceManagers || []);
  const hasYoutube = sources.has("youtube") || sources.has("youtubemusic") || sources.has("ytmusic");
  const hasDeezer = sources.has("deezer") || sources.has("deezerm");
  const hasSoundCloud = sources.has("soundcloud");
  const hasSpotify = sources.has("spotify");

  if (hasYoutube) score += 95;
  if (hasDeezer) score += 80;
  if (hasSoundCloud) score += 65;
  if (hasSpotify) score += 45;
  if (sources.has("http")) score += 15;

  const hasCoreMusic = hasYoutube || hasDeezer || hasSoundCloud;
  if (!hasCoreMusic) {
    // Skip/demote niche nodes that don't carry YouTube, Deezer, or SoundCloud at all
    score -= 500;
  } else if (probe.nodeType === NodeType.NodeLink) {
    // NodeLink v3+ handles YouTube/Deezer/SoundCloud/Spotify natively with low overhead
    score += 75;
  }

  // Prefer nodes that support full EQ + timescale audio filters (d!eq, d!bb, d!filter)
  if (hasFullAudioFilters(probe.info)) {
    score += 80;
  }

  // Strongly favor nearby low-latency nodes
  score -= Math.min((probe.latencyMs || 0) * 0.45, 900);

  // Evaluate real load and frame health
  const cpuLoad = getServerCpuLoad(probe.stats);
  const playingPlayers = Number(probe.stats?.playingPlayers) || 0;
  const stutterPenalty = computeFrameStutterPenalty(probe.stats);
  score -= Math.min(cpuLoad * 300, 300);
  score -= stutterPenalty;

  if (playingPlayers >= 10 && cpuLoad < 0.35 && stutterPenalty <= 120) {
    // Battle-tested live cluster serving many streams cleanly with low CPU & healthy frames
    score += 60;
  } else if (cpuLoad >= 0.35 || stutterPenalty > 150) {
    score -= Math.min(playingPlayers * 4, 150);
  }

  // Penalize tiny/throttled VPS nodes burning high CPU with almost no active players
  if (playingPlayers <= 5 && cpuLoad >= 0.08) {
    score -= 120;
  }

  return score;
}

/**
 * Fetch candidate public Lavalink v4 / NodeLink v3 nodes from the community directory API.
 * @param {string} directoryUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function fetchPublicNodeCandidates(
  directoryUrl,
  { fetchImpl = fetch, timeoutMs = 8000 } = {},
) {
  const candidates = [];

  try {
    const res = await fetchImpl(directoryUrl, {
      headers: { Accept: "application/json", "User-Agent": "DiscordMusicBot/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        for (const item of list) {
          const version = String(item?.version || "").trim().toLowerCase();
          // Skip only explicitly legacy Lavalink v3 entries; allow v4, unknown (NodeLink v3!), and blank
          if (version === "v3" || version.startsWith("v3.") || version.startsWith("3.")) continue;
          if (!item?.host || !item?.port || !item?.password) continue;

          const port = Number(item.port);
          const secure = Boolean(item.secure);
          // lavalink-client throws SyntaxError if secure=true with a non-443 port
          if (secure && port !== 443) continue;

          candidates.push({
            id: String(item.identifier || item["unique-id"] || `${item.host}-${port}`),
            host: String(item.host).trim(),
            port,
            authorization: String(item.password),
            secure,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[Nodes] Public directory fetch failed (${err.message}); using fallback seed nodes.`);
  }

  // Append fallback seeds and deduplicate by host:port
  const seen = new Set();
  const deduped = [];
  for (const node of [...candidates, ...FALLBACK_PUBLIC_NODES]) {
    const key = `${node.host.toLowerCase()}:${node.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(node);
  }
  return deduped;
}

/**
 * Convert a node definition to full lavalink-client LavalinkNodeOptions.
 * @param {{ id: string, host: string, port: number, authorization: string, secure: boolean }} node
 * @param {NodeType} [nodeType]
 */
export function toLavalinkNodeOptions(node, nodeType = NodeType.Lavalink) {
  return {
    id: node.id,
    host: node.host,
    port: node.port,
    authorization: node.authorization,
    secure: Boolean(node.secure),
    nodeType,
    retryAmount: 5,
    retryDelay: 10_000,
    requestSignalTimeoutMS: 8_000,
    heartBeatInterval: 20_000,
    enablePingOnStatsCheck: true,
    autoChecks: {
      pluginValidations: false,
      sourcesValidations: false,
    },
  };
}

/**
 * Resolve the final ordered list of Lavalink/NodeLink nodes to connect to on startup.
 * Prioritizes user-configured custom nodes, then fastest healthy DAVE-compatible public nodes
 * across distinct providers so automatic failover always has truly independent backup servers.
 *
 * @param {ReturnType<import("../config.js").loadConfig>} config
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function resolveStartupNodes(config, { fetchImpl = fetch } = {}) {
  const finalNodes = [];
  const seenKeys = new Set();

  // 1. Always preserve user-configured custom / self-hosted nodes
  if (config.customNodes.length > 0) {
    const customProbes = await Promise.all(
      config.customNodes.map((n) => probeNode(n, { fetchImpl, timeoutMs: 3000 })),
    );

    for (const probe of customProbes) {
      const key = `${probe.node.host.toLowerCase()}:${probe.node.port}`;
      seenKeys.add(key);

      if (probe.ok) {
        if (!probe.daveCompatible) {
          console.warn(
            `[Nodes] Warning: Custom node "${probe.node.id}" reports version ${probe.version.semver}. Discord requires Lavalink v4.2.0+ (or NodeLink v3+) for mandatory DAVE voice encryption.`,
          );
        } else {
          console.log(
            `[Nodes] Custom node "${probe.node.id}" verified (${probe.nodeType} ${probe.version.semver}, ${probe.latencyMs}ms).`,
          );
        }
        finalNodes.push(toLavalinkNodeOptions(probe.node, probe.nodeType));
      } else {
        console.warn(
          `[Nodes] Custom node "${probe.node.id}" did not answer preflight (${probe.reason}); keeping it configured so lavalink-client can retry.`,
        );
        finalNodes.push(toLavalinkNodeOptions(probe.node, NodeType.Lavalink));
      }
    }
  }

  // 2. Discover fastest healthy free public Lavalink v4.2+ / NodeLink v3+ nodes when enabled
  if (config.autoPublicNodes) {
    console.log("[Nodes] Discovering fastest free public Lavalink v4.2+ / NodeLink v3+ (DAVE-compatible) nodes...");
    const candidates = await fetchPublicNodeCandidates(config.publicNodesUrl, { fetchImpl });
    const probes = await Promise.all(
      candidates.slice(0, 40).map((n) => probeNode(n, { fetchImpl, timeoutMs: 3500 })),
    );

    const healthy = probes.filter((p) => p.ok);
    const daveReady = healthy.filter((p) => p.daveCompatible);

    const sorted = (daveReady.length > 0 ? daveReady : healthy).sort(
      (a, b) => scoreProbedNode(b) - scoreProbedNode(a),
    );

    // Pick highest-scoring node per unique provider/domain first so failover spans distinct physical servers
    const seenProviders = new Set();
    const ranked = [];
    for (const probe of sorted) {
      if (ranked.length >= config.maxPublicNodes) break;
      const provider = extractProviderKey(probe.node.host);
      if (seenProviders.has(provider)) continue;
      seenProviders.add(provider);
      ranked.push(probe);
    }

    if (daveReady.length === 0 && healthy.length > 0) {
      console.warn(
        "[Nodes] No public node reported Lavalink >= 4.2.0 / NodeLink v3+ on /v4/info. Using best reachable v4 nodes as fallback.",
      );
    }

    for (const probe of ranked) {
      const key = `${probe.node.host.toLowerCase()}:${probe.node.port}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const cpuVal = probe.stats?.cpu?.lavalinkLoad ?? probe.stats?.cpu?.nodelinkLoad;
      const load =
        cpuVal !== undefined
          ? `${(Number(cpuVal) * 100).toFixed(1)}% CPU, ${probe.stats.playingPlayers ?? 0} playing`
          : "stats n/a";
      console.log(
        `[Nodes] Selected "${probe.node.id}" (${probe.nodeType} ${probe.version.semver}, DAVE=${probe.daveCompatible ? "yes" : "unverified"}, ${probe.latencyMs}ms, ${load})`,
      );
      finalNodes.push(toLavalinkNodeOptions(probe.node, probe.nodeType));
    }
  }

  // 3. Last-resort fallback so LavalinkManager always has at least one node entry
  if (finalNodes.length === 0) {
    console.warn("[Nodes] No nodes answered preflight. Loading fallback seed nodes for retry.");
    for (const seed of FALLBACK_PUBLIC_NODES) {
      const fallbackType = seed.host.includes("nodelink") ? NodeType.NodeLink : NodeType.Lavalink;
      finalNodes.push(toLavalinkNodeOptions(seed, fallbackType));
    }
  }

  return finalNodes;
}
