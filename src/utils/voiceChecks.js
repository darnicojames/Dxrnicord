import { PermissionFlagsBits } from "discord.js";

/**
 * Verify that the interacting member is in a voice channel and that the bot
 * has permission to join and speak in it.
 *
 * @param {import("discord.js").ChatInputCommandInteraction | import("discord.js").ButtonInteraction | import("discord.js").StringSelectMenuInteraction} interaction
 * @param {{ requireSameChannel?: boolean, player?: any }} [opts]
 * @returns {{ ok: true, voiceChannel: import("discord.js").VoiceBasedChannel } | { ok: false, error: string }}
 */
export function validateVoiceState(interaction, { requireSameChannel = false, player = null } = {}) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return { ok: false, error: "Join a voice channel first before using music commands." };
  }

  if (requireSameChannel && player?.voiceChannelId && player.voiceChannelId !== voiceChannel.id) {
    return {
      ok: false,
      error: `You must be in <#${player.voiceChannelId}> to control the music player.`,
    };
  }

  const botMember = interaction.guild?.members?.me;
  if (botMember) {
    const perms = voiceChannel.permissionsFor(botMember);
    if (!perms?.has(PermissionFlagsBits.Connect)) {
      return { ok: false, error: `I don't have permission to **Connect** to <#${voiceChannel.id}>.` };
    }
    if (!perms?.has(PermissionFlagsBits.Speak)) {
      return { ok: false, error: `I don't have permission to **Speak** in <#${voiceChannel.id}>.` };
    }
  }

  return { ok: true, voiceChannel };
}

/**
 * Verify that an active player exists and the user is in the same voice channel.
 */
export function requireActivePlayer(interaction, client) {
  const player = client.lavalink.getPlayer(interaction.guildId);
  if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
    return { ok: false, error: "Nothing is currently playing in this server." };
  }

  const voice = validateVoiceState(interaction, { requireSameChannel: true, player });
  if (!voice.ok) {
    return { ok: false, error: voice.error };
  }

  return { ok: true, player, voiceChannel: voice.voiceChannel };
}
