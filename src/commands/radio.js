import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { validateExternalUrl, validatePlayInput } from "../security/guard.js";
import { EQ_PRESETS, applyEqToPlayer, getEqPresetBands } from "../services/audioPresets.js";
import { pickFastestConnectedNode } from "../services/nodeDiscovery.js";
import {
  RADIO_STATIONS,
  resolveCuratedStation,
  searchRadioStations,
  tuneRadioStream,
} from "../services/radio.js";
import { COLORS, buildStatusEmbed } from "../ui/embeds.js";
import { getTextEmoji } from "../ui/emojis.js";
import { validateVoiceState } from "../utils/voiceChecks.js";

async function startRadioSession({
  message,
  station,
  client,
  config,
  guildSettings,
  voiceTracker,
  refreshPublicNodes,
  updateTarget = null,
}) {
  const existingPlayer = client.lavalink.getPlayer(message.guildId);
  const voice = validateVoiceState(message, {
    requireSameChannel: Boolean(existingPlayer),
    player: existingPlayer,
  });
  if (!voice.ok) {
    const payload = { embeds: [buildStatusEmbed(voice.error, "warning")], components: [] };
    return updateTarget ? updateTarget.update(payload) : message.reply(payload);
  }

  if (!client.lavalink.useable && config.autoPublicNodes && refreshPublicNodes) {
    await refreshPublicNodes();
  }

  if (!client.lavalink.useable) {
    const payload = {
      embeds: [buildStatusEmbed("No audio server (Lavalink node) is currently connected.", "error")],
      components: [],
    };
    return updateTarget ? updateTarget.update(payload) : message.reply(payload);
  }

  const serverPrefs = guildSettings.get(message.guildId);
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

  if (!existingPlayer) {
    player.setData("sessionHostId", message.author.id);
  }
  player.textChannelId = message.channelId;

  // Automatically enable 24/7 Stay Mode + save active station for auto-reconnect watchdog
  guildSettings.setStay247(message.guildId, true);
  guildSettings.setRadioStation(message.guildId, station);
  player.deleteData("_radioRetryCount");

  if (voiceTracker) {
    await voiceTracker.connectAndWaitReady(player);
  } else if (!player.connected) {
    await player.connect();
  }

  const requester = { id: message.author.id, username: message.author.username };
  const result = await tuneRadioStream(player, station, requester);

  if (!result.ok) {
    guildSettings.setRadioStation(message.guildId, null);
    const payload = {
      embeds: [buildStatusEmbed(`Could not start radio: ${result.error}`, "error")],
      components: [],
    };
    return updateTarget ? updateTarget.update(payload) : message.reply(payload);
  }

  if (!existingPlayer && serverPrefs.defaultEq && EQ_PRESETS[serverPrefs.defaultEq]) {
    applyEqToPlayer(
      player,
      getEqPresetBands(serverPrefs.defaultEq),
      EQ_PRESETS[serverPrefs.defaultEq].name,
    ).catch(() => {});
  }

  const icon = getTextEmoji("http");
  const embed = new EmbedBuilder()
    .setColor(serverPrefs.themeColor ?? COLORS.SUCCESS)
    .setTitle(`${icon} 24/7 Radio Tuned In`)
    .setDescription(
      `**${station.name}**\n${station.genre || "24/7 Live Internet Radio"}\n\n` +
        `24/7 mode is now **ON** — the stream will keep playing continuously and auto-reconnect if the radio server hiccups.\n` +
        `Use \`${config.prefix}radio off\` or \`${config.prefix}stop\` to stop.`,
    );

  if (station.favicon) embed.setThumbnail(station.favicon);

  const payload = { embeds: [embed], components: [] };
  return updateTarget ? updateTarget.update(payload) : message.reply(payload);
}

export const radioCommand = {
  name: "radio",
  aliases: ["rad", "fm", "station"],
  usage: "radio [station | search <genre> | <stream URL> | list | off]",
  description: "Stream continuous 24/7 internet radio in voice (auto-enables 24/7 mode & auto-reconnect)",

  async execute(message, args, context) {
    const { client, config, guildSettings } = context;
    const p = config.prefix;
    const themeColor = guildSettings.get(message.guildId).themeColor ?? COLORS.PRIMARY;
    const icon = getTextEmoji("http");
    const firstArg = (args[0] || "").trim();
    const firstLower = firstArg.toLowerCase();

    // 1. Stop / turn off radio mode: `d!radio off`
    if (["off", "stop", "disable"].includes(firstLower)) {
      const active = guildSettings.getRadioStation(message.guildId);
      guildSettings.setRadioStation(message.guildId, null);
      guildSettings.setStay247(message.guildId, false);
      const player = client.lavalink.getPlayer(message.guildId);
      if (player) {
        await player.destroy("radio-stopped").catch(() => {});
      }
      return message.reply({
        embeds: [
          buildStatusEmbed(
            active
              ? `${icon} Turned off 24/7 radio (**${active.name}**) and disconnected.`
              : `${icon} Radio mode disabled.`,
            "info",
          ),
        ],
      });
    }

    // 2. List built-in curated stations: `d!radio list`
    if (firstLower === "list" || firstLower === "stations") {
      const lines = Object.values(RADIO_STATIONS).map(
        (s) => `• \`${p}radio ${s.key}\` — **${s.name}** (${s.genre})`,
      );
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(themeColor)
            .setTitle(`${icon} Built-in 24/7 Radio Stations`)
            .setDescription(
              `${lines.join("\n")}\n\n` +
                `You can also search 40,000+ live stations worldwide with \`${p}radio search <genre/country>\`, or paste a direct stream URL with \`${p}radio https://...\`.`,
            ),
        ],
      });
    }

    // 3. No arguments -> show active radio + interactive station picker dropdown!
    if (!firstArg) {
      const active = guildSettings.getRadioStation(message.guildId);
      const customId = `radio_pick_${message.id}`;

      const menu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder("Pick a 24/7 radio station to start streaming...")
        .addOptions(
          Object.values(RADIO_STATIONS).map((s) => ({
            label: s.name.slice(0, 100),
            description: s.genre.slice(0, 100),
            value: s.key,
          })),
        );

      const embed = new EmbedBuilder()
        .setColor(themeColor)
        .setTitle(`${icon} 24/7 Radio Mode`)
        .setDescription(
          `**Current Station:** ${active ? `**${active.name}** (Live 24/7)` : "Off"}\n\n` +
            `Pick a station below to start continuous 24/7 music in your voice channel, or use:\n` +
            `• \`${p}radio lofi\` / \`chill\` / \`pop\` / \`dance\` / \`hiphop\` / \`rock\` / \`anime\` / \`kpop\` / \`jazz\`\n` +
            `• \`${p}radio search <genre or country>\` — search 40,000+ live stations\n` +
            `• \`${p}radio <https://stream-url>\` — custom radio stream\n` +
            `• \`${p}radio off\` — stop radio & 24/7 mode`,
        )
        .setFooter({ text: "Select a station within 30 seconds" });

      const sent = await message.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
      });

      try {
        const pick = await sent.awaitMessageComponent({
          componentType: ComponentType.StringSelect,
          filter: (i) => i.user.id === message.author.id && i.customId === customId,
          time: 30_000,
        });

        const chosen = RADIO_STATIONS[pick.values[0]];
        await startRadioSession({
          message,
          station: chosen,
          ...context,
          updateTarget: pick,
        });
      } catch {
        await sent.edit({ components: [] }).catch(() => {});
      }
      return undefined;
    }

    // 4. Direct custom stream URL: `d!radio https://...`
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(firstArg)) {
      const check = validateExternalUrl(firstArg);
      if (!check.ok) {
        return message.reply({
          embeds: [buildStatusEmbed(`🛡️ ${check.error}`, "warning")],
        });
      }
      message.channel.sendTyping().catch(() => {});
      const station = {
        key: `custom:${check.url.hostname}`,
        name: `Custom Radio (${check.url.hostname})`,
        genre: "Custom 24/7 Live Stream",
        url: check.url.toString(),
        backupUrls: [],
      };
      return startRadioSession({ message, station, ...context });
    }

    // 5. Built-in curated station shortcut: `d!radio lofi`, `d!radio kpop`, etc.
    if (args.length === 1) {
      const curated = resolveCuratedStation(firstArg);
      if (curated) {
        message.channel.sendTyping().catch(() => {});
        return startRadioSession({ message, station: curated, ...context });
      }
    }

    // 6. Search worldwide live stations via Radio Browser API: `d!radio search <query>` or `d!radio <genre>`
    const rawSearch = firstLower === "search" ? args.slice(1).join(" ").trim() : args.join(" ").trim();
    const inputCheck = validatePlayInput(rawSearch);
    if (!inputCheck.ok) {
      return message.reply({ embeds: [buildStatusEmbed(`🛡️ ${inputCheck.error}`, "warning")] });
    }

    message.channel.sendTyping().catch(() => {});
    const matches = await searchRadioStations(inputCheck.query, { limit: 5 });

    if (matches.length === 0) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `No live radio stations found for **${inputCheck.query}**. Try \`${p}radio list\` for built-in 24/7 stations.`,
            "warning",
          ),
        ],
      });
    }

    const customId = `radio_search_${message.id}`;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose a live radio station...")
      .addOptions(
        matches.map((s, idx) => ({
          label: s.name.slice(0, 100),
          description: s.genre.slice(0, 100),
          value: String(idx),
        })),
      );

    const lines = matches.map((s, idx) => `\`${idx + 1}.\` **${s.name}** — ${s.genre}`);
    const sent = await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(themeColor)
          .setTitle(`${icon} Live Radio Search: "${inputCheck.query}"`)
          .setDescription(lines.join("\n"))
          .setFooter({ text: "Select a station within 30 seconds to start 24/7 radio" }),
      ],
      components: [new ActionRowBuilder().addComponents(menu)],
    });

    try {
      const pick = await sent.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === message.author.id && i.customId === customId,
        time: 30_000,
      });

      const chosen = matches[Number.parseInt(pick.values[0], 10)];
      await startRadioSession({
        message,
        station: chosen,
        ...context,
        updateTarget: pick,
      });
    } catch {
      await sent.edit({ components: [] }).catch(() => {});
    }
    return undefined;
  },
};
