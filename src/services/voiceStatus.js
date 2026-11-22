/**
 * Update or clear the Discord Voice Channel Status line displayed right under
 * the voice channel name in the server sidebar (no emojis, clean plain text).
 *
 * Requires the bot to have "Set Voice Channel Status" permission in the server/channel.
 * Fails silently if the permission is not granted.
 */

const MAX_VOICE_STATUS_LEN = 120;

/**
 * Format emoji-free bot status text displaying the current server count.
 * @param {number} guildCount
 * @param {string} [prefix]
 */
export function formatServerCountStatus(guildCount, prefix = "d!") {
  const count = Math.max(0, Number(guildCount) || 0);
  const label = count === 1 ? "server" : "servers";
  return `${count} ${label} | ${prefix}help`;
}

/**
 * Format clean, emoji-free voice channel status text for a track.
 * @param {string} title
 * @param {string} [author]
 */
export function formatVoiceStatusText(title, author) {
  const cleanTitle = String(title || "Music").replace(/\s+/g, " ").trim();
  const cleanAuthor = String(author || "").replace(/\s+/g, " ").trim();
  const base = cleanAuthor ? `Now playing: ${cleanTitle} - ${cleanAuthor}` : `Now playing: ${cleanTitle}`;
  if (base.length <= MAX_VOICE_STATUS_LEN) return base;
  return `${base.slice(0, MAX_VOICE_STATUS_LEN - 3)}...`;
}

/**
 * Set the voice channel status string via Discord REST API v10.
 * @param {import("discord.js").Client} client
 * @param {string | null | undefined} voiceChannelId
 * @param {string} statusText
 */
export async function setVoiceChannelStatus(client, voiceChannelId, statusText) {
  if (!client?.rest || !voiceChannelId) return;
  try {
    await client.rest.put(`/channels/${voiceChannelId}/voice-status`, {
      body: { status: String(statusText || "").slice(0, 500) },
    });
  } catch {
    // Permission may not be enabled or channel may no longer exist — stay quiet
  }
}

/**
 * Clear the voice channel status line.
 * @param {import("discord.js").Client} client
 * @param {string | null | undefined} voiceChannelId
 */
export async function clearVoiceChannelStatus(client, voiceChannelId) {
  await setVoiceChannelStatus(client, voiceChannelId, "");
}
