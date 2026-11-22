import { Events, MessageFlags } from "discord.js";
import { RateLimiter, checkAccess, redactSecrets } from "../security/guard.js";
import { evaluateSkipRequest } from "../services/voteSkip.js";
import {
  buildNowPlayingEmbed,
  buildPlayerControls,
  buildStatusEmbed,
} from "../ui/embeds.js";
import { requireActivePlayer } from "../utils/voiceChecks.js";

/** Snappy button limiter (400ms cooldown) so Pause/Resume/Skip clicks feel instant. */
const buttonRateLimiter = new RateLimiter({
  cooldownMs: 400,
  windowMs: 10_000,
  maxPerWindow: 15,
});

/**
 * Cycle repeat mode: off -> track -> queue -> off
 */
function nextRepeatMode(current) {
  if (current === "off") return "track";
  if (current === "track") return "queue";
  return "off";
}

/**
 * Handle interactive buttons attached to Now Playing cards with full security checks
 * and optimistic parallel UI updates so buttons respond instantly without spinning.
 */
async function handleMusicButton(interaction, { client, config, guildSettings }) {
  const check = requireActivePlayer(interaction, client);
  if (!check.ok) {
    return interaction.reply({
      embeds: [buildStatusEmbed(check.error, "warning")],
      flags: MessageFlags.Ephemeral,
    });
  }

  const { player, voiceChannel } = check;
  const prefs = guildSettings?.get(interaction.guildId) || {};

  const access = checkAccess({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    member: interaction.member,
    voiceChannel,
    player,
    commandName: interaction.customId,
    config,
  });

  if (!access.ok) {
    return interaction.reply({
      embeds: [buildStatusEmbed(`🛡️ ${access.error}`, "warning")],
      flags: MessageFlags.Ephemeral,
    });
  }

  const limit = buttonRateLimiter.check(interaction.user.id);
  if (!limit.allowed) {
    const waitSec = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return interaction.reply({
      embeds: [buildStatusEmbed(`⏱️ Please wait **${waitSec}s** before clicking again.`, "warning")],
      flags: MessageFlags.Ephemeral,
    });
  }

  switch (interaction.customId) {
    case "music_pause": {
      const isPrebuffering = Boolean(player.getData("_prebuffering"));
      const targetPaused = isPrebuffering ? true : !player.paused;
      if (isPrebuffering) {
        player.setData("_userPausedDuringPrebuffer", true);
      }
      const current = player.queue.current;

      // Fire Lavalink pause/resume AND Discord UI update in parallel for instant responsiveness!
      const lavalinkOp = targetPaused ? player.pause() : player.resume();
      const uiOp = current
        ? interaction.update({
            embeds: [
              buildNowPlayingEmbed(player, current, {
                autoplay: prefs.autoplay,
                stay247: prefs.stay247,
                themeColor: prefs.themeColor,
                pausedOverride: targetPaused,
              }),
            ],
            components: [buildPlayerControls(player, { pausedOverride: targetPaused })],
          })
        : interaction.deferUpdate();

      await Promise.all([lavalinkOp, uiOp]);
      return undefined;
    }

    case "music_skip": {
      const voteSkipEnabled = guildSettings ? guildSettings.isVoteSkip(interaction.guildId) : true;
      const decision = evaluateSkipRequest({
        player,
        member: interaction.member,
        userId: interaction.user.id,
        voiceChannel,
        voteSkipEnabled,
      });

      if (decision.action === "already-voted") {
        return interaction.reply({
          embeds: [
            buildStatusEmbed(
              `🗳️ You already voted to skip (**${decision.votes}/${decision.required}**). Waiting for **${decision.remaining}** more listener(s) in voice.`,
              "info",
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (decision.action === "voted") {
        return interaction.reply({
          embeds: [
            buildStatusEmbed(
              `🗳️ **Vote Skip: ${decision.votes}/${decision.required}** — **${decision.remaining}** more listener(s) in voice need to click Skip or run \`${config.prefix}skip\` to agree!`,
              "info",
            ),
          ],
        });
      }

      if (player.queue.tracks.length === 0) {
        await Promise.all([
          player.stopPlaying(false, false),
          interaction.update({ components: [] }).catch(() => {}),
        ]);
        return undefined;
      }
      await Promise.all([player.skip(0, false), interaction.deferUpdate()]);
      return undefined;
    }

    case "music_shuffle": {
      if (player.queue.tracks.length < 2) {
        return interaction.reply({
          embeds: [buildStatusEmbed("Need at least 2 upcoming tracks to shuffle.", "warning")],
          flags: MessageFlags.Ephemeral,
        });
      }
      await player.queue.shuffle();
      return interaction.reply({
        embeds: [
          buildStatusEmbed(`🔀 Shuffled **${player.queue.tracks.length}** upcoming tracks.`, "success"),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    case "music_loop": {
      const next = nextRepeatMode(player.repeatMode || "off");
      const current = player.queue.current;

      const lavalinkOp = player.setRepeatMode(next);
      const uiOp = current
        ? interaction.update({
            embeds: [
              buildNowPlayingEmbed(player, current, {
                autoplay: prefs.autoplay,
                stay247: prefs.stay247,
                themeColor: prefs.themeColor,
                repeatModeOverride: next,
              }),
            ],
            components: [buildPlayerControls(player, { repeatModeOverride: next })],
          })
        : interaction.deferUpdate();

      await Promise.all([lavalinkOp, uiOp]);
      return undefined;
    }

    case "music_stop": {
      guildSettings?.setRadioStation(interaction.guildId, null);
      await Promise.all([
        player.destroy("stopped-via-button"),
        interaction.update({
          embeds: [buildStatusEmbed("⏹️ Playback stopped and disconnected.", "info")],
          components: [],
        }),
      ]);
      return undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Attach Discord interactionCreate listener ONLY for Now Playing buttons.
 * Slash commands are intentionally disabled (prefix-only d! mode).
 */
export function registerInteractionHandler(client, context) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith("music_")) {
        if (!interaction.inGuild()) return;
        await handleMusicButton(interaction, context);
      }
    } catch (err) {
      const safeMsg = redactSecrets(err?.message || "Unexpected error", [
        context.config.discordToken,
        context.config.spotifyClientSecret,
      ]);
      console.error("[Interaction] Unhandled error:", safeMsg);
      const errorPayload = {
        embeds: [buildStatusEmbed(`Something went wrong: ${safeMsg}`, "error")],
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(errorPayload).catch(() => {});
      } else {
        await interaction.reply(errorPayload).catch(() => {});
      }
    }
  });
}
