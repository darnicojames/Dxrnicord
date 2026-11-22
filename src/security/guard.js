import { PermissionFlagsBits } from "discord.js";

export const MAX_QUERY_LENGTH = 500;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);

/**
 * Determine whether a parsed URL hostname targets a local, private, loopback,
 * link-local, or cloud-metadata address (SSRF protection).
 *
 * @param {string} rawHostname
 * @returns {boolean}
 */
export function isBlockedHost(rawHostname) {
  const host = String(rawHostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }

  // Block pure integer / hex / octal / shorthand dotted IPv4 encodings (e.g. 2130706433, 0x7f000001, 0177.0.0.1, 127.1)
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) {
    return true;
  }
  if (/^(?:(?:0x[0-9a-f]+|\d+)\.){1,3}(?:0x[0-9a-f]+|\d+)$/i.test(host)) {
    const standardIpv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!standardIpv4) return true;
    if (standardIpv4.slice(1).some((part) => part.length > 1 && part.startsWith("0"))) {
      return true;
    }
    const [a, b, c, d] = standardIpv4.slice(1).map((n) => Number.parseInt(n, 10));
    if ([a, b, c, d].some((n) => n < 0 || n > 255)) return true;

    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 private / loopback / link-local / IPv4-mapped checks
  if (host.includes(":")) {
    if (host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:0:0:0") {
      return true;
    }
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // Unique local (fc00::/7)
    if (/^fe[89ab]/i.test(host)) return true; // Link-local (fe80::/10)
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      return isBlockedHost(mapped);
    }
  }

  return false;
}

/**
 * Validate a URL string for safe external HTTP(S) access.
 * @param {string} rawUrl
 * @returns {{ ok: true, url: URL } | { ok: false, error: string }}
 */
export function validateExternalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL format." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only `http://` and `https://` links are allowed." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "URLs containing embedded credentials are not allowed." };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "Local, private, or internal network URLs are blocked for security." };
  }

  return { ok: true, url: parsed };
}

/**
 * Sanitize and validate user input passed to d!play or d!search.
 * @param {string} rawInput
 * @returns {{ ok: true, query: string } | { ok: false, error: string }}
 */
export function validatePlayInput(rawInput) {
  const cleaned = String(rawInput || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();

  if (!cleaned) {
    return { ok: false, error: "Please provide a song name or link." };
  }

  if (cleaned.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      error: `Query is too long (maximum ${MAX_QUERY_LENGTH} characters).`,
    };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned)) {
    const check = validateExternalUrl(cleaned);
    if (!check.ok) return check;
  }

  return { ok: true, query: cleaned };
}

/**
 * Strip sensitive tokens/passwords from logs or user-facing error messages.
 * @param {string} text
 * @param {string[]} secrets
 */
export function redactSecrets(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) {
      output = output.split(secret).join("[REDACTED]");
    }
  }
  return output;
}

/**
 * Sliding-window per-user rate limiter to protect free-tier hosting from command spam.
 */
export class RateLimiter {
  /**
   * @param {{ cooldownMs?: number, windowMs?: number, maxPerWindow?: number }} [opts]
   */
  constructor({ cooldownMs = 2000, windowMs = 15_000, maxPerWindow = 8 } = {}) {
    this.cooldownMs = cooldownMs;
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    /** @type {Map<string, number[]>} */
    this.history = new Map();
  }

  /**
   * Check and record a user action.
   * @param {string} userId
   * @param {number} [now]
   * @returns {{ allowed: true } | { allowed: false, retryAfterMs: number, reason: string }}
   */
  check(userId, now = Date.now()) {
    const recent = (this.history.get(userId) || []).filter((ts) => now - ts < this.windowMs);

    if (recent.length > 0) {
      const sinceLast = now - recent[recent.length - 1];
      if (sinceLast < this.cooldownMs) {
        this.history.set(userId, recent);
        return {
          allowed: false,
          retryAfterMs: this.cooldownMs - sinceLast,
          reason: "cooldown",
        };
      }
    }

    if (recent.length >= this.maxPerWindow) {
      const oldest = recent[0];
      const retryAfterMs = Math.max(1000, this.windowMs - (now - oldest));
      this.history.set(userId, recent);
      return {
        allowed: false,
        retryAfterMs,
        reason: "burst",
      };
    }

    recent.push(now);
    this.history.set(userId, recent);

    // Opportunistic pruning to keep RAM footprint flat over 24/7 uptime
    if (this.history.size > 500) {
      this.prune(now);
    }

    return { allowed: true };
  }

  prune(now = Date.now()) {
    for (const [uid, timestamps] of this.history.entries()) {
      const fresh = timestamps.filter((ts) => now - ts < this.windowMs);
      if (fresh.length === 0) {
        this.history.delete(uid);
      } else {
        this.history.set(uid, fresh);
      }
    }
  }
}

/**
 * Strictly verify that at least one of the member's roles explicitly grants
 * ADMINISTRATOR or MANAGE_GUILD (Manage Server) permission.
 */
export function hasAdminRole(member) {
  const roles = member?.roles?.cache;
  if (!roles || typeof roles.some !== "function") return false;
  return roles.some(
    (role) =>
      role?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
      role?.permissions?.has?.(PermissionFlagsBits.ManageGuild),
  );
}

/**
 * Determine if a guild member satisfies strict Admin/Owner customization permissions
 * (requires a role with ADMINISTRATOR or MANAGE SERVER permission).
 */
export function isOwnerOrAdmin(member) {
  return hasAdminRole(member);
}

/**
 * Determine if a guild member satisfies DJ permissions.
 */
export function hasDjPrivileges({ member, userId, voiceChannel, player, commandName, config }) {
  if (hasAdminRole(member)) return true;

  if (member?.permissions?.has?.(PermissionFlagsBits.MoveMembers)) return true;

  // Check explicit DJ role IDs or DJ role name
  const roles = member?.roles?.cache;
  if (roles) {
    if (config.djRoleIds.size > 0 && roles.some((r) => config.djRoleIds.has(r.id))) {
      return true;
    }
    if (
      config.djRoleName &&
      roles.some((r) => r.name.toLowerCase() === config.djRoleName.toLowerCase())
    ) {
      return true;
    }
  }

  // Session host (first person who made the bot join VC) can control playback
  const sessionHostId = typeof player?.getData === "function" ? player.getData("sessionHostId") : null;
  if (sessionHostId && sessionHostId === userId) return true;

  // If the user is alone with the bot in voice, they can control playback
  if (voiceChannel?.members) {
    const otherHumans = voiceChannel.members.filter((m) => !m.user.bot && m.id !== userId).size;
    if (otherHumans === 0) return true;
  }

  // Track requester can pause/skip/seek their own song
  if (
    ["skip", "pause", "seek", "music_skip", "music_pause"].includes(commandName) &&
    player?.queue?.current?.requester?.id === userId
  ) {
    return true;
  }

  return false;
}

const ADMIN_ONLY_COMMANDS = new Set(["nodes", "security", "emojis", "settings"]);
const DJ_CONTROL_COMMANDS = new Set([
  "stop",
  "clear",
  "skip",
  "remove",
  "volume",
  "loop",
  "shuffle",
  "seek",
  "filter",
  "eq",
  "bassboost",
  "treble",
  "speed",
  "pitch",
  "resetfx",
  "pause",
  "autoplay",
  "247",
  "radio",
  "music_pause",
  "music_skip",
  "music_shuffle",
  "music_loop",
  "music_stop",
]);

/**
 * Central access-control check for prefix commands and player buttons.
 *
 * @returns {{ ok: true } | { ok: false, silent?: boolean, error: string }}
 */
export function checkAccess({
  guildId,
  channelId,
  userId,
  member,
  voiceChannel,
  player,
  commandName,
  config,
}) {
  // 1. Server allowlist
  if (config.allowedGuildIds.size > 0 && !config.allowedGuildIds.has(guildId)) {
    return { ok: false, silent: true, error: "This server is not authorized to use this bot." };
  }

  // 2. Text channel allowlist (bypassed by roles with Administrator / Manage Server)
  if (
    config.allowedChannelIds.size > 0 &&
    channelId &&
    !config.allowedChannelIds.has(channelId) &&
    !hasAdminRole(member)
  ) {
    return {
      ok: false,
      silent: true,
      error: "Music commands are restricted to designated channel(s).",
    };
  }

  // 3. Explicit user allowlist (bypassed by roles with Administrator / Manage Server)
  if (
    config.allowedUserIds.size > 0 &&
    !config.allowedUserIds.has(userId) &&
    !hasAdminRole(member)
  ) {
    return { ok: false, error: "You are not authorized to use this bot." };
  }

  // 4. Admin customization & diagnostic commands strictly require Administrator or Manage Server role
  if (ADMIN_ONLY_COMMANDS.has(commandName) && !hasAdminRole(member)) {
    return {
      ok: false,
      error: "This command requires a role with **Administrator** or **Manage Server** permission.",
    };
  }

  // 5. Optional DJ role enforcement on playback controls
  if (config.requireDjRole && DJ_CONTROL_COMMANDS.has(commandName)) {
    const allowed = hasDjPrivileges({
      member,
      userId,
      voiceChannel,
      player,
      commandName,
      config,
    });
    if (!allowed) {
      const roleHint = config.djRoleName ? `**${config.djRoleName}** role` : "DJ role";
      return {
        ok: false,
        error: `Security check: you need the ${roleHint}, admin permissions, or to be alone in the voice channel to use this control.`,
      };
    }
  }

  return { ok: true };
}
