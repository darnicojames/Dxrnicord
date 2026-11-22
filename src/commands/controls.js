import { hasAdminRole } from "../security/guard.js";
import { pickFastestConnectedNode } from "../services/nodeDiscovery.js";
import { clearVoiceChannelStatus } from "../services/voiceStatus.js";
import { canJumpSkip, evaluateSkipRequest } from "../services/voteSkip.js";
import {
  buildStatusEmbed,
  formatDuration,
  getTrackDisplay,
  parseTimeToMs,
} from "../ui/embeds.js";
import { requireActivePlayer, validateVoiceState } from "../utils/voiceChecks.js";

export const joinCommand = {
  name: "join",
  aliases: ["j", "connect", "summon"],
  usage: "join",
  description: "Make the bot join your current voice channel",

  async execute(message, _args, { client, config, guildSettings, voiceTracker, refreshPublicNodes }) {
    const existingPlayer = client.lavalink.getPlayer(message.guildId);
    const voice = validateVoiceState(message, { requireSameChannel: false });
    if (!voice.ok) {
      return message.reply({ embeds: [buildStatusEmbed(voice.error, "warning")] });
    }

    if (existingPlayer?.voiceChannelId === voice.voiceChannel.id && existingPlayer.connected) {
      return message.reply({
        embeds: [buildStatusEmbed(`Already connected to <#${voice.voiceChannel.id}>.`, "info")],
      });
    }

    // Moving from another VC
    if (existingPlayer && existingPlayer.voiceChannelId && existingPlayer.voiceChannelId !== voice.voiceChannel.id) {
      const isBusy = existingPlayer.playing || existingPlayer.queue.tracks.length > 0;
      const isHost = existingPlayer.getData("sessionHostId") === message.author.id;
      if (isBusy && !isHost && !hasAdminRole(message.member)) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `I'm currently playing music in <#${existingPlayer.voiceChannelId}>.`,
              "warning",
            ),
          ],
        });
      }

      const oldChannelId = existingPlayer.voiceChannelId;
      clearVoiceChannelStatus(client, oldChannelId).catch(() => {});
      voiceTracker?.clear(message.guildId);
      await existingPlayer.changeVoiceState({
        voiceChannelId: voice.voiceChannel.id,
        selfDeaf: true,
        selfMute: false,
      });
      existingPlayer.textChannelId = message.channelId;
      if (!isBusy) {
        existingPlayer.setData("sessionHostId", message.author.id);
      }
      return message.reply({
        embeds: [buildStatusEmbed(`Moved to <#${voice.voiceChannel.id}>.`, "success")],
      });
    }

    if (!client.lavalink.useable && config.autoPublicNodes && refreshPublicNodes) {
      await refreshPublicNodes();
    }

    if (!client.lavalink.useable) {
      return message.reply({
        embeds: [
          buildStatusEmbed("No audio server (Lavalink node) is currently connected.", "error"),
        ],
      });
    }

    const serverPrefs = guildSettings?.get(message.guildId) || {};
    const player =
      existingPlayer ||
      client.lavalink.createPlayer({
        guildId: message.guildId,
        voiceChannelId: voice.voiceChannel.id,
        textChannelId: message.channelId,
        vcRegion: voice.voiceChannel.rtcRegion || undefined,
        selfDeaf: true,
        selfMute: false,
        volume: serverPrefs.defaultVolume ?? config.defaultVolume,
        node: pickFastestConnectedNode(client),
      });

    player.setData("sessionHostId", message.author.id);
    player.textChannelId = message.channelId;

    if (voiceTracker) {
      await voiceTracker.connectAndWaitReady(player);
    } else if (!player.connected) {
      await player.connect();
    }

    return message.reply({
      embeds: [
        buildStatusEmbed(
          `Joined <#${voice.voiceChannel.id}> and ready to play! Use \`${config.prefix}play <song>\` or \`${config.prefix}radio\`.`,
          "success",
        ),
      ],
    });
  },
};

export const pauseCommand = {
  name: "pause",
  aliases: ["resume"],
  usage: "pause",
  description: "Pause or resume the current track",

  async execute(message, _args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const { player } = check;
    if (player.paused && !player.getData("_prebuffering")) {
      await player.resume();
      return message.reply({ embeds: [buildStatusEmbed("▶️ Resumed playback.", "success")] });
    }
    if (player.getData("_prebuffering")) {
      player.setData("_userPausedDuringPrebuffer", true);
    }
    await player.pause();
    return message.reply({ embeds: [buildStatusEmbed("⏸️ Paused playback.", "info")] });
  },
};

export const skipCommand = {
  name: "skip",
  aliases: ["s", "next"],
  usage: "skip [position]",
  description: "Skip the current track or jump to a specific queue number",

  async execute(message, args, { client, config, guildSettings }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const { player, voiceChannel } = check;
    const voteSkipEnabled = guildSettings ? guildSettings.isVoteSkip(message.guildId) : true;
    const rawPos = args[0];
    let skipTo = null;
    if (rawPos !== undefined) {
      if (!/^\d+$/.test(rawPos) || Number.parseInt(rawPos, 10) < 1) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Please provide a valid positive queue number (e.g. \`${config.prefix}skip 3\`).`,
              "warning",
            ),
          ],
        });
      }
      skipTo = Number.parseInt(rawPos, 10);

      if (
        !canJumpSkip({
          player,
          member: message.member,
          userId: message.author.id,
          voiceChannel,
          voteSkipEnabled,
        })
      ) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              "Only the session host (first person who summoned the bot), track requester, or an Admin can jump ahead multiple tracks. Use `d!skip` to vote-skip the current song.",
              "warning",
            ),
          ],
        });
      }
    }

    const skippedTitle = player.queue.current
      ? getTrackDisplay(player.queue.current).title
      : "current track";

    if (skipTo && player.queue.tracks.length === 0) {
      return message.reply({
        embeds: [buildStatusEmbed("There are no upcoming tracks in the queue.", "warning")],
      });
    }

    if (skipTo && skipTo > player.queue.tracks.length) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `Queue only has **${player.queue.tracks.length}** upcoming track(s).`,
            "warning",
          ),
        ],
      });
    }

    // Evaluate instant-skip privilege (Admin role / Session Host / Track Requester / Solo) vs Vote-Skip
    const decision = evaluateSkipRequest({
      player,
      member: message.member,
      userId: message.author.id,
      voiceChannel,
      voteSkipEnabled,
    });

    if (decision.action === "already-voted") {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `🗳️ You already voted to skip (**${decision.votes}/${decision.required}**). Waiting for **${decision.remaining}** more listener(s) in voice to run \`${config.prefix}skip\`.`,
            "info",
          ),
        ],
      });
    }

    if (decision.action === "voted") {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `🗳️ **Vote Skip: ${decision.votes}/${decision.required}** — **${decision.remaining}** more person in voice needs to run \`${config.prefix}skip\` to agree!\n*(The session host, track requester, and admins can skip immediately.)*`,
            "info",
          ),
        ],
      });
    }

    const voteTag =
      decision.reason === "vote-passed"
        ? ` (vote passed ${decision.votes}/${decision.required})`
        : "";

    if (player.queue.tracks.length === 0) {
      await player.stopPlaying(false, false);
      return message.reply({
        embeds: [
          buildStatusEmbed(`⏭️ Skipped **${skippedTitle}**${voteTag} (queue is now empty).`, "info"),
        ],
      });
    }

    await player.skip(skipTo ?? 0, false);
    return message.reply({
      embeds: [
        buildStatusEmbed(
          skipTo
            ? `⏭️ Jumped ahead to track **#${skipTo}** in the queue.`
            : `⏭️ Skipped **${skippedTitle}**${voteTag}.`,
          "success",
        ),
      ],
    });
  },
};

export const stopCommand = {
  name: "stop",
  aliases: ["dc", "disconnect", "leave"],
  usage: "stop",
  description: "Stop playback, clear the queue, and leave the voice channel",

  async execute(message, _args, { client, guildSettings }) {
    const player = client.lavalink.getPlayer(message.guildId);
    guildSettings?.setRadioStation(message.guildId, null);
    if (!player) {
      return message.reply({
        embeds: [buildStatusEmbed("I am not currently connected to a voice channel.", "warning")],
      });
    }

    const check = requireActivePlayer(message, client);
    if (!check.ok && (player.queue.current || player.queue.tracks.length > 0)) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    await player.destroy("stopped-by-user");
    return message.reply({
      embeds: [buildStatusEmbed("⏹️ Stopped playback, cleared the queue, and disconnected.", "info")],
    });
  },
};

export const volumeCommand = {
  name: "volume",
  aliases: ["vol", "v"],
  usage: "volume <1-150>",
  description: "View or set the playback volume (1–150%)",

  async execute(message, args, { client, config }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    if (!args[0]) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `🔊 Current volume is **${check.player.volume}%**. Change it with \`${config.prefix}volume <1-150>\`.`,
            "info",
          ),
        ],
      });
    }

    const level = Number.parseInt(args[0], 10);
    if (!Number.isInteger(level) || level < 1 || level > 150) {
      return message.reply({
        embeds: [buildStatusEmbed("Volume must be a number between **1** and **150**.", "warning")],
      });
    }

    await check.player.setVolume(level);
    return message.reply({
      embeds: [buildStatusEmbed(`🔊 Volume set to **${level}%**.`, "success")],
    });
  },
};

export const loopCommand = {
  name: "loop",
  aliases: ["repeat"],
  usage: "loop [off|track|queue]",
  description: "Set or cycle repeat mode (off, track, or queue)",

  async execute(message, args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const raw = (args[0] || "").toLowerCase();
    let mode;
    if (!raw) {
      mode =
        check.player.repeatMode === "off"
          ? "track"
          : check.player.repeatMode === "track"
            ? "queue"
            : "off";
    } else if (["off", "none", "disable"].includes(raw)) {
      mode = "off";
    } else if (["track", "song", "one"].includes(raw)) {
      mode = "track";
    } else if (["queue", "all"].includes(raw)) {
      mode = "queue";
    } else {
      return message.reply({
        embeds: [buildStatusEmbed("Valid loop modes: `off`, `track`, or `queue`.", "warning")],
      });
    }

    await check.player.setRepeatMode(mode);
    const label =
      mode === "track"
        ? "🔂 Repeating current track"
        : mode === "queue"
          ? "🔁 Repeating entire queue"
          : "➡️ Loop disabled";
    return message.reply({ embeds: [buildStatusEmbed(label, "success")] });
  },
};

export const shuffleCommand = {
  name: "shuffle",
  aliases: ["shuf"],
  usage: "shuffle",
  description: "Shuffle all upcoming tracks in the queue",

  async execute(message, _args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    if (check.player.queue.tracks.length < 2) {
      return message.reply({
        embeds: [buildStatusEmbed("Need at least 2 upcoming tracks in the queue to shuffle.", "warning")],
      });
    }

    await check.player.queue.shuffle();
    return message.reply({
      embeds: [
        buildStatusEmbed(`🔀 Shuffled **${check.player.queue.tracks.length}** upcoming tracks.`, "success"),
      ],
    });
  },
};

export const seekCommand = {
  name: "seek",
  aliases: [],
  usage: "seek <time>",
  description: "Jump to a timestamp in the current track (e.g. 1:30 or 90)",

  async execute(message, args, { client, config }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const current = check.player.queue.current;
    if (!current || current.info.isStream || !current.info.isSeekable) {
      return message.reply({
        embeds: [buildStatusEmbed("This track or live stream cannot be seeked.", "warning")],
      });
    }

    if (!args[0]) {
      return message.reply({
        embeds: [buildStatusEmbed(`Usage: \`${config.prefix}seek 1:30\` or \`${config.prefix}seek 90\``, "info")],
      });
    }

    const targetMs = parseTimeToMs(args[0]);
    if (targetMs === null) {
      return message.reply({
        embeds: [buildStatusEmbed("Invalid time format. Try `1:30`, `90`, or `1:05:00`.", "warning")],
      });
    }

    if (targetMs >= current.info.duration) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `Timestamp exceeds track duration (\`${formatDuration(current.info.duration)}\`).`,
            "warning",
          ),
        ],
      });
    }

    await check.player.seek(targetMs);
    return message.reply({
      embeds: [buildStatusEmbed(`⏩ Seeked to \`${formatDuration(targetMs)}\`.`, "success")],
    });
  },
};

export const removeCommand = {
  name: "remove",
  aliases: ["rm"],
  usage: "remove <position>",
  description: "Remove a specific upcoming track from the queue",

  async execute(message, args, { client, config }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const pos = Number.parseInt(args[0], 10);
    if (!Number.isInteger(pos) || pos < 1) {
      return message.reply({
        embeds: [buildStatusEmbed(`Usage: \`${config.prefix}remove <queue number>\``, "info")],
      });
    }

    if (pos > check.player.queue.tracks.length) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `Invalid position. Queue has **${check.player.queue.tracks.length}** upcoming track(s).`,
            "warning",
          ),
        ],
      });
    }

    const track = check.player.queue.tracks[pos - 1];
    await check.player.queue.splice(pos - 1, 1);
    const info = getTrackDisplay(track);

    return message.reply({
      embeds: [buildStatusEmbed(`🗑️ Removed **#${pos}**: ${info.linkedTitle}`, "success")],
    });
  },
};

export const clearCommand = {
  name: "clear",
  aliases: ["clr"],
  usage: "clear",
  description: "Clear all upcoming tracks without stopping the current song",

  async execute(message, _args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const count = check.player.queue.tracks.length;
    if (count === 0) {
      return message.reply({
        embeds: [buildStatusEmbed("The upcoming queue is already empty.", "info")],
      });
    }

    await check.player.queue.splice(0, count);
    return message.reply({
      embeds: [buildStatusEmbed(`🧹 Cleared **${count}** upcoming track(s) from the queue.`, "success")],
    });
  },
};
