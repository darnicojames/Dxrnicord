import { validatePlayInput } from "../security/guard.js";
import { EQ_PRESETS, getEqPresetBands } from "../services/audioPresets.js";
import { pickFastestConnectedNode } from "../services/nodeDiscovery.js";
import {
  hasExplicitSourcePrefix,
  parseSourceOverride,
  resolveQuery,
} from "../services/trackResolver.js";
import { buildQueuedEmbed, buildStatusEmbed } from "../ui/embeds.js";
import { smoothPlay } from "../utils/smoothPlay.js";
import { validateVoiceState } from "../utils/voiceChecks.js";

export const playCommand = {
  name: "play",
  aliases: ["p"],
  usage: "play <song name or URL>",
  description:
    "Play from YouTube, Spotify, SoundCloud, Apple Music, Deezer, Bandcamp, Twitch, or radio URLs (tip: prefix search with yt:, sc:, dz:)",

  async execute(message, args, { client, config, guildSettings, voiceTracker, refreshPublicNodes }) {
    const rawQuery = args.join(" ").trim();
    if (!rawQuery) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `Usage: \`${config.prefix}play <song name or link>\`\nExamples:\n• \`${config.prefix}play blinding lights\`\n• \`${config.prefix}play sc:lofi hip hop\`\n• \`${config.prefix}play https://open.spotify.com/track/...\``,
            "info",
          ),
        ],
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
          buildStatusEmbed(
            `🛡️ Queue limit reached (**${config.maxQueueSize}** tracks max). Remove or wait for tracks to finish.`,
            "warning",
          ),
        ],
      });
    }

    // Non-blocking typing indicator (saves ~250ms vs awaiting a placeholder reply first)
    message.channel.sendTyping().catch(() => {});

    if (!client.lavalink.useable && config.autoPublicNodes && refreshPublicNodes) {
      await refreshPublicNodes();
    }

    if (!client.lavalink.useable) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `No audio server (Lavalink node) is currently connected. Try again in a few seconds (admins can run \`${config.prefix}nodes\`).`,
            "error",
          ),
        ],
      });
    }

    const serverPrefs = guildSettings?.get(message.guildId) || {};
    const explicitSource = hasExplicitSourcePrefix(inputCheck.query);
    const { query, source: preferredSource } = parseSourceOverride(
      inputCheck.query,
      serverPrefs.defaultSource || config.defaultSearchPlatform,
    );

    const fastestNode = existingPlayer ? undefined : pickFastestConnectedNode(client);

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
        node: fastestNode,
      });

    if (!existingPlayer) {
      player.setData("sessionHostId", message.author.id);
    }
    player.textChannelId = message.channelId;
    const wasAlreadyConnected = Boolean(player.connected);

    const requester = {
      id: message.author.id,
      username: message.author.username,
    };

    try {
      // Run Discord Voice + DAVE MLS handshake readiness IN PARALLEL with track resolution!
      // Eliminates intro stuttering without adding extra wait time.
      const [, resolved] = await Promise.all([
        voiceTracker
          ? voiceTracker.connectAndWaitReady(player)
          : player.connected
            ? Promise.resolve()
            : player.connect(),
        resolveQuery({
          player,
          query,
          requester,
          preferredSource,
          explicitSource,
          config,
        }),
      ]);

      if (!resolved.tracks || resolved.tracks.length === 0) {
        if (!wasAlreadyConnected && !player.playing && player.queue.tracks.length === 0) {
          await player.destroy("empty-search").catch(() => {});
        }
        return message.reply({
          embeds: [
            buildStatusEmbed(
              resolved.note || `No results found for **${query}**. Try another link or search query.`,
              "warning",
            ),
          ],
        });
      }

      const remainingSlots = Math.max(0, config.maxQueueSize - player.queue.tracks.length);
      if (remainingSlots === 0) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `🛡️ Queue limit reached (**${config.maxQueueSize}** tracks max).`,
              "warning",
            ),
          ],
        });
      }

      // If switching from 24/7 radio to an on-demand track, turn off radio auto-retune and play immediately
      const wasRadio = Boolean(guildSettings?.getRadioStation(message.guildId));
      if (wasRadio) {
        guildSettings.setRadioStation(message.guildId, null);
      }

      const isPlaylist = resolved.loadType === "playlist" && resolved.tracks.length > 1;
      const tracksToAdd = isPlaylist
        ? resolved.tracks.slice(0, remainingSlots)
        : [resolved.tracks[0]];

      await player.queue.add(isPlaylist ? tracksToAdd : tracksToAdd[0]);

      const shouldStartNow = wasRadio || (!player.playing && !player.paused);
      if (wasRadio) {
        await player.skip(0, false).catch(() => player.play());
      } else if (shouldStartNow) {
        // Apply server's default EQ atomically inside the FIRST play() PATCH (zero intro seek stutter!)
        const initialPlayOptions = {};
        if (!existingPlayer && serverPrefs.defaultEq && EQ_PRESETS[serverPrefs.defaultEq]) {
          const bands = getEqPresetBands(serverPrefs.defaultEq);
          initialPlayOptions.filters = { equalizer: bands };
          player.setData("activeFiltersPayload", { equalizer: bands });
          player.setData("activeEqLabel", EQ_PRESETS[serverPrefs.defaultEq].name);
          if (player.filterManager) player.filterManager.equalizerBands = [...bands];
        }
        await smoothPlay(player, initialPlayOptions);
      }

      // If starting a single track immediately, `trackStart` posts the rich Now Playing card directly
      // (avoids sending two duplicate cards back-to-back!). Always confirm playlists and queued tracks.
      if (!shouldStartNow || isPlaylist) {
        const embed = buildQueuedEmbed({
          tracks: tracksToAdd,
          playlist: isPlaylist ? resolved.playlist : null,
          isPlayingNow: shouldStartNow,
        });

        if (isPlaylist && tracksToAdd.length < resolved.tracks.length) {
          embed.setFooter({
            text: `Capped at ${tracksToAdd.length} tracks due to server queue limit (${config.maxQueueSize}).`,
          });
        }

        return message.reply({ embeds: [embed] });
      }
      return undefined;
    } catch (err) {
      if (!wasAlreadyConnected && !player.playing && player.queue.tracks.length === 0) {
        await player.destroy("play-error").catch(() => {});
      }
      throw err;
    }
  },
};
