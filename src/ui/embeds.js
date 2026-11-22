import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { getButtonEmoji, getTextEmoji } from "./emojis.js";

export const COLORS = {
  PRIMARY: 0x5865f2, // Discord Blurple
  SUCCESS: 0x2ecc71,
  WARNING: 0xf1c40f,
  ERROR: 0xe74c3c,
  SPOTIFY: 0x1db954,
  YOUTUBE: 0xff0033,
  SOUNDCLOUD: 0xff5500,
};

const SOURCE_META = {
  youtube: { label: "YouTube", color: COLORS.YOUTUBE },
  youtubemusic: { label: "YouTube Music", color: COLORS.YOUTUBE },
  ytmusic: { label: "YouTube Music", color: COLORS.YOUTUBE },
  spotify: { label: "Spotify", color: COLORS.SPOTIFY },
  soundcloud: { label: "SoundCloud", color: COLORS.SOUNDCLOUD },
  applemusic: { label: "Apple Music", color: 0xfa243c },
  deezer: { label: "Deezer", color: 0xa238ff },
  deezerm: { label: "Deezer", color: 0xa238ff },
  bandcamp: { label: "Bandcamp", color: 0x1da0c3 },
  twitch: { label: "Twitch", color: 0x9146ff },
  vimeo: { label: "Vimeo", color: 0x1ab7ea },
  http: { label: "Direct Stream", color: COLORS.PRIMARY },
};

/**
 * Format milliseconds into `m:ss` or `h:mm:ss` (or `LIVE` for streams).
 * @param {number} ms
 * @param {boolean} [isStream]
 */
export function formatDuration(ms, isStream = false) {
  if (isStream) return "LIVE";
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Parse a user-supplied timestamp string (`90`, `1:30`, `1:02:03`) into milliseconds.
 * Returns null if invalid.
 * @param {string} input
 * @returns {number | null}
 */
export function parseTimeToMs(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const secs = Number.parseInt(raw, 10);
    return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
  }

  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;

  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.length === 2) {
    const [m, s] = nums;
    if (s >= 60) return null;
    return (m * 60 + s) * 1000;
  }

  const [h, m, s] = nums;
  if (m >= 60 || s >= 60) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

/**
 * Build an inline visual progress bar.
 */
export function buildProgressBar(positionMs, durationMs, size = 14) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "🔴 LIVE STREAM";
  }
  const ratio = Math.min(1, Math.max(0, (positionMs || 0) / durationMs));
  const index = Math.min(size - 1, Math.floor(ratio * size));
  let bar = "";
  for (let i = 0; i < size; i++) {
    bar += i === index ? "🔘" : "▬";
  }
  return `\`${formatDuration(positionMs)}\` ${bar} \`${formatDuration(durationMs)}\``;
}

/**
 * Escape brackets in track titles so Discord markdown links render cleanly.
 */
export function escapeMarkdownLinkText(text, maxLen = 70) {
  const cleaned = String(text || "Unknown Track")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

/**
 * Extract human-friendly display details for a track (preserving Spotify/Apple/Deezer origin info).
 */
export function getTrackDisplay(track) {
  const clientData = track?.pluginInfo?.clientData || {};
  const title = clientData.originTitle || track?.info?.title || "Unknown Title";
  const author = clientData.originAuthor || track?.info?.author || "Unknown Artist";
  const uri = clientData.originUrl || track?.info?.uri || null;
  const artworkUrl =
    clientData.originArtworkUrl || track?.info?.artworkUrl || track?.pluginInfo?.artworkUrl || null;
  const rawSource = String(clientData.originPlatform || track?.info?.sourceName || "http").toLowerCase();
  const source = SOURCE_META[rawSource] || { label: rawSource.toUpperCase(), color: COLORS.PRIMARY };
  const sourceEmoji = getTextEmoji(rawSource);
  const sourceDisplay = sourceEmoji ? `${sourceEmoji} ${source.label}` : source.label;
  const isStream = Boolean(track?.info?.isStream);
  const duration = Number(track?.info?.duration) || 0;
  const durationText = formatDuration(duration, isStream);

  const safeTitle = escapeMarkdownLinkText(title, 75);
  const linkedTitle = uri ? `[${safeTitle}](${uri})` : `**${safeTitle}**`;

  const requester = track?.requester;
  const requesterMention = requester?.id ? `<@${requester.id}>` : requester?.username || "Unknown";

  return {
    title,
    author,
    uri,
    artworkUrl,
    sourceKey: rawSource,
    sourceLabel: source.label,
    sourceDisplay,
    color: source.color,
    isStream,
    duration,
    durationText,
    linkedTitle,
    requesterMention,
  };
}

/**
 * Interactive player control buttons shown beneath Now Playing messages.
 * Automatically uses custom uploaded App Emojis if present (`play`, `pause`, `skip`, `shuffle`, `loop`, `stop`).
 */
export function buildPlayerControls(player, { pausedOverride, repeatModeOverride } = {}) {
  const isPaused = pausedOverride !== undefined ? Boolean(pausedOverride) : Boolean(player?.paused);
  const loopMode = repeatModeOverride ?? player?.repeatMode ?? "off";
  const loopLabel =
    loopMode === "off" ? "Loop: Off" : loopMode === "track" ? "Loop: Track" : "Loop: Queue";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel(isPaused ? "Resume" : "Pause")
      .setEmoji(getButtonEmoji(isPaused ? "play" : "pause"))
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("Skip")
      .setEmoji(getButtonEmoji("skip"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setLabel("Shuffle")
      .setEmoji(getButtonEmoji("shuffle"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_loop")
      .setLabel(loopLabel)
      .setEmoji(getButtonEmoji("loop"))
      .setStyle(loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("Stop")
      .setEmoji(getButtonEmoji("stop"))
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Build the rich Now Playing embed.
 */
export function buildNowPlayingEmbed(
  player,
  track,
  {
    showProgress = false,
    autoplay = false,
    stay247 = false,
    themeColor = null,
    pausedOverride,
    repeatModeOverride,
  } = {},
) {
  const info = getTrackDisplay(track);
  const playingIcon = getTextEmoji("playing");
  const isPaused = pausedOverride !== undefined ? Boolean(pausedOverride) : Boolean(player.paused);
  const activeRepeat = repeatModeOverride ?? player.repeatMode;
  const loopLabel =
    activeRepeat === "track"
      ? "Track"
      : activeRepeat === "queue"
        ? "Queue"
        : "Off";

  const lines = [
    `${playingIcon ? `${playingIcon} ` : ""}**${info.linkedTitle}**`,
    `by **${escapeMarkdownLinkText(info.author, 60)}**`,
  ];

  if (showProgress) {
    lines.push("", buildProgressBar(player.position, info.duration));
  }

  const footerParts = [
    `Volume: ${player.volume}%`,
    `Loop: ${loopLabel}`,
    `Up Next: ${player.queue.tracks.length}`,
  ];
  const eqLabel = typeof player.getData === "function" ? player.getData("activeEqLabel") : null;
  if (eqLabel && eqLabel !== "Flat (Off)") footerParts.push(`EQ: ${eqLabel}`);
  if (autoplay) footerParts.push("Autoplay: ON");
  if (stay247) footerParts.push("24/7: ON");

  const embed = new EmbedBuilder()
    .setColor(themeColor ?? info.color)
    .setAuthor({ name: isPaused ? "Paused" : "Now Playing" })
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Duration", value: info.durationText, inline: true },
      { name: "Platform", value: info.sourceDisplay, inline: true },
      { name: "Requested By", value: info.requesterMention, inline: true },
    )
    .setFooter({ text: footerParts.join(" • ") });

  if (info.artworkUrl) {
    embed.setThumbnail(info.artworkUrl);
  }

  return embed;
}

/**
 * Build an embed when a single track or playlist is queued.
 */
export function buildQueuedEmbed({ tracks, playlist, isPlayingNow }) {
  const musicIcon = getTextEmoji("music");

  if (playlist && tracks.length > 1) {
    const totalMs = tracks.reduce((sum, t) => sum + (Number(t?.info?.duration) || 0), 0);
    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle("Playlist Queued")
      .setDescription(
        `${musicIcon ? `${musicIcon} ` : ""}` +
          (playlist.uri
            ? `**[${escapeMarkdownLinkText(playlist.name || playlist.title, 80)}](${playlist.uri})**`
            : `**${escapeMarkdownLinkText(playlist.name || playlist.title, 80)}**`),
      )
      .addFields(
        { name: "Tracks Added", value: String(tracks.length), inline: true },
        { name: "Total Duration", value: totalMs > 0 ? formatDuration(totalMs) : "Mixed", inline: true },
      );

    if (playlist.thumbnail) {
      embed.setThumbnail(playlist.thumbnail);
    }
    return embed;
  }

  const info = getTrackDisplay(tracks[0]);
  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(isPlayingNow ? "Starting Playback" : "Added to Queue")
    .setDescription(
      `${musicIcon ? `${musicIcon} ` : ""}**${info.linkedTitle}**\nby **${escapeMarkdownLinkText(info.author, 60)}**`,
    )
    .addFields(
      { name: "Duration", value: info.durationText, inline: true },
      { name: "Platform", value: info.sourceDisplay, inline: true },
      { name: "Requested By", value: info.requesterMention, inline: true },
    );

  if (info.artworkUrl) {
    embed.setThumbnail(info.artworkUrl);
  }
  return embed;
}

/**
 * Build a paginated queue embed.
 */
export function buildQueueEmbed(player, page = 1, pageSize = 10, themeColor = null) {
  const current = player.queue.current;
  const upcoming = player.queue.tracks;
  const totalPages = Math.max(1, Math.ceil(upcoming.length / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, page));
  const start = (safePage - 1) * pageSize;
  const slice = upcoming.slice(start, start + pageSize);

  const lines = [];
  if (current) {
    const curr = getTrackDisplay(current);
    lines.push(
      `**Now Playing:** ${curr.linkedTitle} \`[${curr.durationText}]\` (${curr.requesterMention})`,
      "",
    );
  }

  if (slice.length === 0) {
    lines.push("_No upcoming tracks in the queue._");
  } else {
    lines.push("**Up Next:**");
    for (let i = 0; i < slice.length; i++) {
      const item = getTrackDisplay(slice[i]);
      lines.push(
        `\`${start + i + 1}.\` ${item.linkedTitle} \`[${item.durationText}]\` • ${item.requesterMention}`,
      );
    }
  }

  const totalQueueMs = upcoming.reduce((sum, t) => sum + (Number(t?.info?.duration) || 0), 0);

  return new EmbedBuilder()
    .setColor(themeColor ?? COLORS.PRIMARY)
    .setTitle("Music Queue")
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `Page ${safePage}/${totalPages} • ${upcoming.length} upcoming • Queue length: ${formatDuration(totalQueueMs)} • Loop: ${player.repeatMode}`,
    });
}

/**
 * Quick status/info/error embed helper.
 */
export function buildStatusEmbed(message, type = "info") {
  const color =
    type === "error"
      ? COLORS.ERROR
      : type === "success"
        ? COLORS.SUCCESS
        : type === "warning"
          ? COLORS.WARNING
          : COLORS.PRIMARY;
  return new EmbedBuilder().setColor(color).setDescription(message);
}
