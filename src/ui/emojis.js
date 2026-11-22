/**
 * Auto-loaded Discord Application Emojis with clean Unicode fallbacks.
 * Upload custom PNG/GIF emojis in Discord Developer Portal -> Emojis using
 * any of the slot names below (case-insensitive) and Dxrnicord uses them automatically!
 */

export const EMOJI_FALLBACKS = {
  // Interactive player buttons
  play: "▶️",
  pause: "⏸️",
  skip: "⏭️",
  shuffle: "🔀",
  loop: "🔁",
  stop: "⏹️",

  // Platform badges
  youtube: "🔴",
  youtubemusic: "🎵",
  spotify: "🟢",
  soundcloud: "🟠",
  applemusic: "🍎",
  deezer: "🟣",
  bandcamp: "💿",
  twitch: "🟣",
  vimeo: "🔵",
  http: "📻",

  // UI & feature icons
  playing: "🎵",
  music: "🎶",
  queue: "📜",
  volume: "🔊",
  lyrics: "🎤",
  autoplay: "♾️",
  stay247: "🕒",
  filter: "🎛️",
  security: "🛡️",
  nodes: "🖥️",
};

/** @type {Map<string, { id: string, name: string, animated: boolean, formatted: string }>} */
const customAppEmojis = new Map();

/**
 * Fetch all Application Emojis uploaded in Discord Developer Portal -> Emojis.
 * Safe to call on boot and via `d!emojis refresh`.
 *
 * @param {import("discord.js").Client} client
 * @returns {Promise<number>} Number of loaded custom application emojis
 */
export async function loadAppEmojis(client) {
  customAppEmojis.clear();
  try {
    if (!client?.application?.emojis) return 0;
    const fetched = await client.application.emojis.fetch();
    for (const emoji of fetched.values()) {
      const key = String(emoji.name || "").toLowerCase();
      if (!key) continue;
      const animated = Boolean(emoji.animated);
      customAppEmojis.set(key, {
        id: emoji.id,
        name: emoji.name,
        animated,
        formatted: animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`,
      });
    }
    return customAppEmojis.size;
  } catch (err) {
    console.warn(`[Emojis] Could not fetch application emojis: ${err?.message || err}`);
    return 0;
  }
}

/**
 * Get emoji string suitable for embeds/messages (`<:name:id>` or Unicode fallback).
 * @param {keyof typeof EMOJI_FALLBACKS | string} key
 * @returns {string}
 */
export function getTextEmoji(key) {
  const normalized = String(key || "").toLowerCase();
  const custom = customAppEmojis.get(normalized);
  if (custom) return custom.formatted;
  return EMOJI_FALLBACKS[normalized] || "";
}

/**
 * Get emoji payload suitable for Discord ButtonBuilder#setEmoji().
 * @param {keyof typeof EMOJI_FALLBACKS | string} key
 * @returns {string | { id: string, name: string, animated: boolean }}
 */
export function getButtonEmoji(key) {
  const normalized = String(key || "").toLowerCase();
  const custom = customAppEmojis.get(normalized);
  if (custom) {
    return { id: custom.id, name: custom.name, animated: custom.animated };
  }
  return EMOJI_FALLBACKS[normalized] || "🎵";
}

/**
 * Return snapshot of all currently loaded custom App Emojis (for `d!emojis` & tests).
 */
export function getLoadedAppEmojis() {
  return [...customAppEmojis.entries()].map(([key, value]) => ({ key, ...value }));
}

/**
 * Test helper to seed/reset custom emojis directly.
 */
export function _setCustomEmojisForTest(entries = []) {
  customAppEmojis.clear();
  for (const item of entries) {
    const key = String(item.name).toLowerCase();
    const animated = Boolean(item.animated);
    customAppEmojis.set(key, {
      id: item.id,
      name: item.name,
      animated,
      formatted: animated ? `<a:${item.name}:${item.id}>` : `<:${item.name}:${item.id}>`,
    });
  }
}
