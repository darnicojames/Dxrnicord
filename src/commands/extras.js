import { EmbedBuilder } from "discord.js";
import { validatePlayInput } from "../security/guard.js";
import {
  EQ_PRESETS,
  NAMED_THEME_COLORS,
  applyEqToPlayer,
  getEqPresetBands,
  parseThemeColor,
  resolveEqPresetKey,
} from "../services/audioPresets.js";
import { chunkLyrics, fetchLyrics } from "../services/lyrics.js";
import {
  EMOJI_FALLBACKS,
  getLoadedAppEmojis,
  getTextEmoji,
  loadAppEmojis,
} from "../ui/emojis.js";
import { COLORS, buildStatusEmbed, getTrackDisplay } from "../ui/embeds.js";
import { validateVoiceState } from "../utils/voiceChecks.js";

export const autoplayCommand = {
  name: "autoplay",
  aliases: ["ap"],
  usage: "autoplay [on|off]",
  description: "Automatically play related songs when the queue finishes",

  async execute(message, args, { client, guildSettings }) {
    const player = client.lavalink.getPlayer(message.guildId);
    const voice = validateVoiceState(message, {
      requireSameChannel: Boolean(player),
      player,
    });
    if (!voice.ok) {
      return message.reply({ embeds: [buildStatusEmbed(voice.error, "warning")] });
    }

    const arg = (args[0] || "").toLowerCase();
    const current = guildSettings.isAutoplay(message.guildId);
    const next =
      arg === "on" || arg === "enable"
        ? true
        : arg === "off" || arg === "disable"
          ? false
          : !current;

    guildSettings.setAutoplay(message.guildId, next);
    const icon = getTextEmoji("autoplay");
    return message.reply({
      embeds: [
        buildStatusEmbed(
          next
            ? `${icon} **Autoplay enabled** — related songs will queue automatically when the queue ends.`
            : `${icon} **Autoplay disabled.**`,
          next ? "success" : "info",
        ),
      ],
    });
  },
};

export const stay247Command = {
  name: "247",
  aliases: ["stay", "alwayson"],
  usage: "247 [on|off]",
  description: "Toggle 24/7 mode so the bot stays in the voice channel even when idle",

  async execute(message, args, { client, config, guildSettings }) {
    const existingPlayer = client.lavalink.getPlayer(message.guildId);
    const voice = validateVoiceState(message, {
      requireSameChannel: Boolean(existingPlayer),
      player: existingPlayer,
    });
    if (!voice.ok) {
      return message.reply({ embeds: [buildStatusEmbed(voice.error, "warning")] });
    }

    const arg = (args[0] || "").toLowerCase();
    const current = guildSettings.isStay247(message.guildId);
    const next =
      arg === "on" || arg === "enable"
        ? true
        : arg === "off" || arg === "disable"
          ? false
          : !current;

    guildSettings.setStay247(message.guildId, next);

    // If enabling 24/7 while not yet in VC and a Lavalink node is ready, join immediately
    if (next && !existingPlayer && client.lavalink.useable) {
      const player = client.lavalink.createPlayer({
        guildId: message.guildId,
        voiceChannelId: voice.voiceChannel.id,
        textChannelId: message.channelId,
        vcRegion: voice.voiceChannel.rtcRegion || undefined,
        selfDeaf: true,
        selfMute: false,
        volume: config.defaultVolume,
      });
      player.setData("sessionHostId", message.author.id);
      await player.connect().catch(() => {});
    }

    const icon = getTextEmoji("stay247");
    return message.reply({
      embeds: [
        buildStatusEmbed(
          next
            ? `${icon} **24/7 mode enabled** — I'll stay in the voice channel until \`${config.prefix}stop\` or \`${config.prefix}247 off\`.`
            : `${icon} **24/7 mode disabled** — I'll auto-leave after ${config.idleLeaveSeconds}s when idle or alone.`,
          next ? "success" : "info",
        ),
      ],
    });
  },
};

export const lyricsCommand = {
  name: "lyrics",
  aliases: ["ly"],
  usage: "lyrics [song name]",
  description: "Fetch song lyrics for the current track or any song title",

  async execute(message, args, { client, config }) {
    const manualQuery = args.join(" ").trim();
    let title = "";
    let author = "";

    if (manualQuery) {
      const check = validatePlayInput(manualQuery);
      if (!check.ok) {
        return message.reply({ embeds: [buildStatusEmbed(`🛡️ ${check.error}`, "warning")] });
      }
    } else {
      const player = client.lavalink.getPlayer(message.guildId);
      const current = player?.queue?.current;
      if (!current) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Nothing is playing right now. Pass a song name: \`${config.prefix}lyrics <song name>\``,
              "info",
            ),
          ],
        });
      }
      const info = getTrackDisplay(current);
      title = info.title;
      author = info.author;
    }

    const icon = getTextEmoji("lyrics");
    const statusMsg = await message.reply({
      embeds: [buildStatusEmbed(`${icon} Looking up lyrics...`, "info")],
    });

    const result = await fetchLyrics({
      title,
      author,
      query: manualQuery || undefined,
    });

    if (!result) {
      return statusMsg.edit({
        embeds: [
          buildStatusEmbed(
            `No lyrics found for **${manualQuery || `${title} - ${author}`}**. Try \`${config.prefix}lyrics <artist> <song>\`.`,
            "warning",
          ),
        ],
      });
    }

    const chunks = chunkLyrics(result.lyrics, 3800).slice(0, 3);
    const embeds = chunks.map((chunk, idx) => {
      const embed = new EmbedBuilder().setColor(COLORS.PRIMARY).setDescription(chunk);
      if (idx === 0) {
        embed.setTitle(`${icon} ${result.title} — ${result.artist}`.slice(0, 256));
      }
      if (idx === chunks.length - 1) {
        embed.setFooter({
          text: result.album ? `Album: ${result.album} • Powered by LRCLIB` : "Powered by LRCLIB",
        });
      }
      return embed;
    });

    return statusMsg.edit({ embeds });
  },
};

export const emojisCommand = {
  name: "emojis",
  aliases: ["emoji"],
  adminOnly: true,
  usage: "emojis [refresh]",
  description: "[Admin] View or reload custom Discord App Emojis uploaded in Developer Portal",

  async execute(message, args, { client, config }) {
    const action = (args[0] || "").toLowerCase();
    let refreshedText = "";

    if (action === "refresh" || action === "reload") {
      const count = await loadAppEmojis(client);
      refreshedText = `Reloaded **${count}** custom App Emoji(s) from Discord Developer Portal.\n\n`;
    }

    const loaded = getLoadedAppEmojis();
    const slotNames = Object.keys(EMOJI_FALLBACKS);
    const loadedMap = new Map(loaded.map((e) => [e.key, e]));

    const activeList = loaded.length
      ? loaded.map((e) => `${e.formatted} \`${e.name}\``).join(" • ")
      : "_None uploaded yet (using built-in defaults)._";

    const missingSlots = slotNames.filter((name) => !loadedMap.has(name));

    const embed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle("Custom App Emojis")
      .setDescription(
        `${refreshedText}**Loaded App Emojis (${loaded.length}):**\n${activeList}\n\n` +
          `**Supported Auto-Detected Emoji Names:**\n` +
          `Upload PNG/GIF icons in **Developer Portal -> Emojis** with any of these exact names, then run \`${config.prefix}emojis refresh\`:\n` +
          `\`${slotNames.join("`, `")}\``,
      )
      .setFooter({
        text: `${slotNames.length - missingSlots.length}/${slotNames.length} slots customized`,
      });

    return message.reply({ embeds: [embed] });
  },
};

const SOURCE_SHORTCUTS = {
  ytm: "ytmsearch",
  youtubemusic: "ytmsearch",
  yt: "ytsearch",
  youtube: "ytsearch",
  sp: "spsearch",
  spotify: "spsearch",
  sc: "scsearch",
  soundcloud: "scsearch",
  dz: "dzsearch",
  deezer: "dzsearch",
};

export const settingsCommand = {
  name: "settings",
  aliases: ["config"],
  adminOnly: true,
  usage: "settings [volume|eq|source|color|reset] [value]",
  description: "[Admin] Customize server defaults (volume, equalizer, search platform, embed theme color)",

  async execute(message, args, { client, config, guildSettings }) {
    const prefs = guildSettings.get(message.guildId);
    const p = config.prefix;
    const sub = (args[0] || "").toLowerCase();
    const val = args[1];

    if (!sub) {
      const eqLabel = prefs.defaultEq ? EQ_PRESETS[prefs.defaultEq]?.name || prefs.defaultEq : "Flat (Off)";
      const embed = new EmbedBuilder()
        .setColor(prefs.themeColor ?? COLORS.PRIMARY)
        .setTitle("Server Bot Customization")
        .setDescription(
          [
            `**Default Volume:** \`${prefs.defaultVolume ?? config.defaultVolume}%\``,
            `**Default Equalizer:** \`${eqLabel}\``,
            `**Default Search Source:** \`${prefs.defaultSource || config.defaultSearchPlatform}\``,
            `**Theme Color:** \`${prefs.themeColorLabel || "default (platform color)"}\``,
            `**Autoplay:** \`${prefs.autoplay ? "ON" : "OFF"}\` • **24/7 Mode:** \`${prefs.stay247 ? "ON" : "OFF"}\` • **Vote-Skip:** \`${prefs.voteSkip !== false ? "ON" : "OFF"}\``,
            "",
            "**Customize with (requires Administrator or Manage Server role):**",
            `• \`${p}settings volume <1-150>\``,
            `• \`${p}settings eq <off|bassboost|trebleboost|vocal|pop|rock|electronic|lofi|...>\``,
            `• \`${p}settings source <ytm|yt|sp|sc|dz>\``,
            `• \`${p}settings color <frog|blurple|spotify|purple|pink|cyan|gold|crimson|#hex|default>\``,
            `• \`${p}settings voteskip <on|off>\``,
            `• \`${p}settings reset\``,
          ].join("\n"),
        );

      return message.reply({ embeds: [embed] });
    }

    if (sub === "volume" || sub === "vol") {
      const level = Number.parseInt(val, 10);
      if (!Number.isInteger(level) || level < 1 || level > 150) {
        return message.reply({
          embeds: [buildStatusEmbed(`Usage: \`${p}settings volume <1-150>\``, "warning")],
        });
      }
      guildSettings.setDefaultVolume(message.guildId, level);
      const player = client.lavalink.getPlayer(message.guildId);
      if (player) await player.setVolume(level).catch(() => {});
      return message.reply({
        embeds: [buildStatusEmbed(`Default server volume set to **${level}%**.`, "success")],
      });
    }

    if (sub === "eq" || sub === "equalizer") {
      const key = resolveEqPresetKey(val);
      if (!key) {
        const list = Object.keys(EQ_PRESETS)
          .map((k) => `\`${k}\``)
          .join(", ");
        return message.reply({
          embeds: [buildStatusEmbed(`Usage: \`${p}settings eq <preset>\`\nAvailable: ${list}`, "warning")],
        });
      }
      guildSettings.setDefaultEq(message.guildId, key === "off" ? null : key);
      const player = client.lavalink.getPlayer(message.guildId);
      if (player) {
        await applyEqToPlayer(player, getEqPresetBands(key), EQ_PRESETS[key].name).catch(() => {});
      }
      return message.reply({
        embeds: [
          buildStatusEmbed(`Default server equalizer set to **${EQ_PRESETS[key].name}**.`, "success"),
        ],
      });
    }

    if (sub === "source" || sub === "search") {
      const mapped = SOURCE_SHORTCUTS[String(val || "").toLowerCase()];
      if (!mapped) {
        return message.reply({
          embeds: [
            buildStatusEmbed(`Usage: \`${p}settings source <ytm|yt|sp|sc|dz>\``, "warning"),
          ],
        });
      }
      guildSettings.setDefaultSource(message.guildId, mapped);
      return message.reply({
        embeds: [buildStatusEmbed(`Default search platform set to **\`${mapped}\`**.`, "success")],
      });
    }

    if (sub === "color" || sub === "colour" || sub === "theme") {
      const parsed = parseThemeColor(val);
      if (!parsed.ok) {
        const names = Object.keys(NAMED_THEME_COLORS)
          .map((c) => `\`${c}\``)
          .join(", ");
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Usage: \`${p}settings color <name or #hex>\`\nNamed colors: ${names}`,
              "warning",
            ),
          ],
        });
      }
      guildSettings.setThemeColor(message.guildId, parsed.color, parsed.label);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(parsed.color ?? COLORS.PRIMARY)
            .setDescription(`Embed theme color updated to **${parsed.label}**.`),
        ],
      });
    }

    if (sub === "voteskip" || sub === "skipvote") {
      const normalized = String(val || "").toLowerCase();
      if (!["on", "off", "enable", "disable", "true", "false"].includes(normalized)) {
        return message.reply({
          embeds: [buildStatusEmbed(`Usage: \`${p}settings voteskip <on|off>\``, "warning")],
        });
      }
      const enabled = ["on", "enable", "true"].includes(normalized);
      guildSettings.setVoteSkip(message.guildId, enabled);
      return message.reply({
        embeds: [
          buildStatusEmbed(
            enabled
              ? "Vote-skip **enabled** — session host, track requester, and admins skip instantly; other listeners vote with `d!skip`."
              : "Vote-skip **disabled** — any listener in the voice channel can skip immediately.",
            "success",
          ),
        ],
      });
    }

    if (sub === "reset") {
      guildSettings.update(message.guildId, {
        defaultVolume: null,
        defaultEq: null,
        defaultSource: null,
        themeColor: null,
        themeColorLabel: null,
        voteSkip: true,
      });
      return message.reply({
        embeds: [buildStatusEmbed("Server customizations reset to default.", "success")],
      });
    }

    return message.reply({
      embeds: [
        buildStatusEmbed(
          `Unknown option \`${sub}\`. Run \`${p}settings\` to see all customization options.`,
          "warning",
        ),
      ],
    });
  },
};
