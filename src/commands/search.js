import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { validatePlayInput } from "../security/guard.js";
import { normalizeSourceName, pickFastestConnectedNode } from "../services/nodeDiscovery.js";
import {
  hasExplicitSourcePrefix,
  materializeDirectTrack,
  parseSourceOverride,
  searchAllSources,
  searchWithFallback,
} from "../services/trackResolver.js";
import {
  COLORS,
  buildQueuedEmbed,
  buildStatusEmbed,
  escapeMarkdownLinkText,
  getTrackDisplay,
} from "../ui/embeds.js";
import { smoothPlay } from "../utils/smoothPlay.js";
import { validateVoiceState } from "../utils/voiceChecks.js";

export const searchCommand = {
  name: "search",
  aliases: ["find"],
  usage: "search <song or artist>",
  description:
    "Search across YouTube, Spotify, Deezer, and SoundCloud at once and pick the exact song from a dropdown",

  async execute(message, args, { client, config, guildSettings, voiceTracker, refreshPublicNodes }) {
    const rawQuery = args.join(" ").trim();
    if (!rawQuery) {
      return message.reply({
        embeds: [buildStatusEmbed(`Usage: \`${config.prefix}search <song or artist>\``, "info")],
      });
    }

    const inputCheck = validatePlayInput(rawQuery);
    if (!inputCheck.ok) {
      return message.reply({
        embeds: [buildStatusEmbed(`🛡️ ${inputCheck.error}`, "warning")],
      });
    }

    const existingPlayer = client.lavalink.getPlayer(message.guildId);
    const voice = validateVoiceState(message, {
      requireSameChannel: Boolean(existingPlayer),
      player: existingPlayer,
    });
    if (!voice.ok) {
      return message.reply({
        embeds: [buildStatusEmbed(voice.error, "warning")],
      });
    }

    if (existingPlayer && existingPlayer.queue.tracks.length >= config.maxQueueSize) {
      return message.reply({
        embeds: [
          buildStatusEmbed(`🛡️ Queue limit reached (**${config.maxQueueSize}** tracks max).`, "warning"),
        ],
      });
    }

    const explicitSource = hasExplicitSourcePrefix(inputCheck.query);
    const statusMsg = await message.reply({
      embeds: [
        buildStatusEmbed(
          explicitSource
            ? "🔎 Searching..."
            : "🔎 Searching YouTube, Spotify, Deezer & SoundCloud...",
          "info",
        ),
      ],
    });

    if (!client.lavalink.useable && config.autoPublicNodes && refreshPublicNodes) {
      await refreshPublicNodes();
    }

    if (!client.lavalink.useable) {
      return statusMsg.edit({
        embeds: [
          buildStatusEmbed("No audio server (Lavalink node) is currently connected.", "error"),
        ],
      });
    }

    const serverPrefs = guildSettings?.get(message.guildId) || {};
    const { query, source: preferredSource } = parseSourceOverride(
      inputCheck.query,
      serverPrefs.defaultSource || config.defaultSearchPlatform,
    );

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

    const createdFresh = !existingPlayer;
    if (createdFresh) {
      player.setData("sessionHostId", message.author.id);
    }
    const requester = { id: message.author.id, username: message.author.username };

    let topTracks = [];
    let respondedSources = [];
    try {
      if (explicitSource) {
        const res = await searchWithFallback(player, query, requester, preferredSource);
        topTracks = (res.tracks || []).slice(0, 8);
      } else {
        const multi = await searchAllSources(player, query, requester, {
          preferredSource,
          perSourceLimit: 3,
          maxTotal: 8,
          timeoutMs: 1200,
          materializeWinner: false,
        });
        topTracks = multi.rankedTracks;
        respondedSources = multi.respondedSources;
      }
    } catch (err) {
      if (createdFresh && !player.playing) await player.destroy("search-error").catch(() => {});
      throw err;
    }

    if (topTracks.length === 0) {
      if (createdFresh && !player.playing) await player.destroy("search-empty").catch(() => {});
      return statusMsg.edit({
        embeds: [buildStatusEmbed(`No results found for **${query}**.`, "warning")],
      });
    }

    const lines = topTracks.map((t, idx) => {
      const info = getTrackDisplay(t);
      return `\`${idx + 1}.\` ${info.linkedTitle} — **${escapeMarkdownLinkText(info.author, 36)}** \`[${info.durationText}]\` • *${info.sourceLabel}*`;
    });

    const customId = `search_pick_${message.id}`;
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose the exact track to play...")
      .addOptions(
        topTracks.map((t, idx) => {
          const info = getTrackDisplay(t);
          return {
            label: `${idx + 1}. ${escapeMarkdownLinkText(info.title, 90)}`.slice(0, 100),
            description: `${info.sourceLabel} • ${escapeMarkdownLinkText(info.author, 55)} • ${info.durationText}`.slice(
              0,
              100,
            ),
            value: String(idx),
          };
        }),
      );

    const footerParts = [];
    if (respondedSources.length > 0) {
      footerParts.push(`Sources: ${respondedSources.join(", ")}`);
    }
    footerParts.push("Only the requester can select • Expires in 30s");

    const embed = new EmbedBuilder()
      .setColor(serverPrefs.themeColor ?? COLORS.PRIMARY)
      .setTitle(`Search Results for "${escapeMarkdownLinkText(query, 60)}"`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: footerParts.join(" • ") });

    await statusMsg.edit({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(selectMenu)],
    });

    try {
      const selection = await statusMsg.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === message.author.id && i.customId === customId,
        time: 30_000,
      });

      await selection.deferUpdate();

      const chosenIndex = Number.parseInt(selection.values[0], 10);
      let chosenTrack = topTracks[chosenIndex];

      // If user picked a Spotify/Apple metadata result, materialize it in parallel with VC connect!
      const chosenSrc = normalizeSourceName(chosenTrack?.info?.sourceName);
      const needsMaterialize = chosenSrc === "spotify" || chosenSrc === "applemusic";

      const [, resolvedTrack] = await Promise.all([
        voiceTracker
          ? voiceTracker.connectAndWaitReady(player)
          : player.connected
            ? Promise.resolve()
            : player.connect(),
        needsMaterialize
          ? materializeDirectTrack(player, chosenTrack, requester, preferredSource)
          : Promise.resolve(chosenTrack),
      ]);
      chosenTrack = resolvedTrack || chosenTrack;
      player.textChannelId = message.channelId;

      await player.queue.add(chosenTrack);
      const shouldStartNow = !player.playing && !player.paused;
      if (shouldStartNow) {
        await smoothPlay(player);
      }

      await statusMsg.edit({
        embeds: [
          buildQueuedEmbed({
            tracks: [chosenTrack],
            playlist: null,
            isPlayingNow: shouldStartNow,
          }),
        ],
        components: [],
      });
    } catch {
      if (createdFresh && !player.playing && player.queue.tracks.length === 0) {
        await player.destroy("search-timeout").catch(() => {});
      }
      await statusMsg
        .edit({
          embeds: [buildStatusEmbed("Search selection timed out.", "warning")],
          components: [],
        })
        .catch(() => {});
    }
  },
};
