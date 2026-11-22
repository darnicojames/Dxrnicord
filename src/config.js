import dotenv from "dotenv";

dotenv.config({ quiet: true });

const ALLOWED_SEARCH_PLATFORMS = new Set([
  "ytmsearch",
  "ytsearch",
  "scsearch",
  "dzsearch",
  "spsearch",
  "amsearch",
  "bcsearch",
]);

/**
 * Parse boolean-like environment variables cleanly.
 * @param {string | undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
export function parseBool(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/**
 * Parse integer environment variables with min/max clamping.
 * @param {string | undefined} value
 * @param {number} defaultValue
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function parseClampedInt(value, defaultValue, min, max) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Parse comma-separated Discord snowflake IDs into a Set.
 * @param {string | undefined} value
 * @returns {Set<string>}
 */
export function parseIdSet(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{15,22}$/.test(s)),
  );
}

/**
 * Parse custom Lavalink nodes from either LAVALINK_NODES JSON or individual env vars.
 * @param {Record<string, string | undefined>} env
 * @returns {Array<{id: string, host: string, port: number, authorization: string, secure: boolean}>}
 */
export function parseCustomNodes(env) {
  const rawJson = env.LAVALINK_NODES?.trim();
  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(`Invalid LAVALINK_NODES JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("LAVALINK_NODES must be a JSON array of node objects.");
    }
    return parsed
      .filter((n) => n && typeof n.host === "string" && n.host.trim())
      .map((n, idx) => ({
        id: String(n.id || n.identifier || `custom-node-${idx + 1}`),
        host: String(n.host).trim(),
        port: Number(n.port) || (n.secure ? 443 : 2333),
        authorization: String(n.authorization ?? n.password ?? "youshallnotpass"),
        secure: Boolean(n.secure),
      }));
  }

  const host = env.LAVALINK_HOST?.trim();
  if (host) {
    const secure = parseBool(env.LAVALINK_SECURE, false);
    const port = parseClampedInt(env.LAVALINK_PORT, secure ? 443 : 2333, 1, 65535);
    return [
      {
        id: env.LAVALINK_ID?.trim() || "primary-node",
        host,
        port,
        authorization: env.LAVALINK_PASSWORD || "youshallnotpass",
        secure,
      },
    ];
  }

  return [];
}

/**
 * Load and normalize runtime configuration from environment variables.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const customNodes = parseCustomNodes(env);
  const autoPublicNodes = parseBool(env.AUTO_PUBLIC_NODES, customNodes.length === 0);

  const requestedSearch = (env.DEFAULT_SEARCH_PLATFORM || "ytmsearch").trim().toLowerCase();
  const defaultSearchPlatform = ALLOWED_SEARCH_PLATFORMS.has(requestedSearch)
    ? requestedSearch
    : "ytmsearch";

  const rawPort = env.PORT || env.HEALTH_PORT;
  const healthPort = rawPort ? parseClampedInt(rawPort, 0, 1, 65535) : null;

  const prefix = (env.COMMAND_PREFIX || "d!").trim() || "d!";
  const djRoleIds = parseIdSet(env.DJ_ROLE_IDS);
  const djRoleName = (env.DJ_ROLE_NAME || "DJ").trim();

  return {
    discordToken: env.DISCORD_TOKEN?.trim() || "",
    prefix,
    devGuildId: env.DEV_GUILD_ID?.trim() || "",
    clearSlashCommands: parseBool(env.CLEAR_SLASH_COMMANDS, true),
    customNodes,
    autoPublicNodes,
    publicNodesUrl:
      env.PUBLIC_LAVALINK_LIST_URL?.trim() || "https://lavalink-list.ajieblogs.eu.org/All",
    maxPublicNodes: parseClampedInt(env.MAX_PUBLIC_NODES, 5, 1, 10),
    defaultSearchPlatform,
    spotifyClientId: env.SPOTIFY_CLIENT_ID?.trim() || "",
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() || "",
    idleLeaveSeconds: parseClampedInt(env.IDLE_LEAVE_SECONDS, 120, 10, 3600),
    defaultVolume: parseClampedInt(env.DEFAULT_VOLUME, 80, 1, 150),
    healthPort,

    // --- Security Controls ---
    ownerIds: parseIdSet(env.OWNER_IDS),
    allowedGuildIds: parseIdSet(env.ALLOWED_GUILD_IDS),
    leaveUnauthorizedGuilds: parseBool(env.LEAVE_UNAUTHORIZED_GUILDS, true),
    allowedChannelIds: parseIdSet(env.ALLOWED_CHANNEL_IDS),
    allowedUserIds: parseIdSet(env.ALLOWED_USER_IDS),
    requireDjRole: parseBool(env.REQUIRE_DJ_ROLE, false),
    djRoleName,
    djRoleIds,
    maxQueueSize: parseClampedInt(env.MAX_QUEUE_SIZE, 200, 1, 1000),
    userCooldownMs: parseClampedInt(env.USER_COOLDOWN_MS, 2000, 250, 30_000),
    maxCommandsPerWindow: parseClampedInt(env.MAX_COMMANDS_PER_WINDOW, 8, 2, 50),
  };
}
