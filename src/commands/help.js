import { EmbedBuilder } from "discord.js";
import { isDaveCompatible } from "../services/nodeDiscovery.js";
import { COLORS } from "../ui/embeds.js";

export const helpCommand = {
  name: "help",
  aliases: ["h", "commands"],
  usage: "help",
  description: "Show all available music commands",

  async execute(message, _args, { config, guildSettings }) {
    const p = config.prefix;
    const themeColor = guildSettings?.get(message.guildId)?.themeColor ?? COLORS.PRIMARY;
    const embed = new EmbedBuilder()
      .setColor(themeColor)
      .setTitle(`Music Bot Commands (${p} prefix)`)
      .addFields(
        {
          name: "🎵 Playback",
          value: [
            `\`${p}join\` (\`${p}j\`, \`${p}summon\`) — Join your current voice channel`,
            `\`${p}play <query or URL>\` (\`${p}p\`) — Searches YouTube, Spotify, Deezer & SoundCloud at once for the exact match (or plays any link)`,
            `\`${p}search <query>\` (\`${p}find\`) — Pick from top 8 matches across YouTube, Spotify, Deezer & SoundCloud`,
            `\`${p}pause\` (\`${p}resume\`) — Pause or resume`,
            `\`${p}skip [pos]\` (\`${p}s\`) — Skip current song or jump to queue #`,
            `\`${p}stop\` (\`${p}dc\`, \`${p}leave\`) — Stop playback & disconnect`,
          ].join("\n"),
        },
        {
          name: "📜 Queue & Info",
          value: [
            `\`${p}queue [page]\` (\`${p}q\`) — View upcoming tracks`,
            `\`${p}nowplaying\` (\`${p}np\`) — Live progress bar & control buttons`,
            `\`${p}shuffle\` (\`${p}shuf\`) • \`${p}loop [off|track|queue]\` • \`${p}seek <1:30>\``,
            `\`${p}remove <#>\` (\`${p}rm\`) • \`${p}clear\` (\`${p}clr\`) • \`${p}lyrics [song]\` (\`${p}ly\`)`,
          ].join("\n"),
        },
        {
          name: "🎛️ Equalizer & Audio Customization",
          value: [
            `\`${p}eq [preset | custom <bass> <mid> <treble>]\` — 15-band EQ & interactive menu`,
            `\`${p}bassboost [0-10]\` (\`${p}bb\`) • \`${p}treble [0-10]\` (\`${p}tb\`) — Quick sliders`,
            `\`${p}filter [preset]\` (\`${p}fx\`) — Nightcore, Slowed, Vaporwave, 8D, Lo-Fi, Karaoke, Vibrato, Tremolo, Chipmunk, Deep`,
            `\`${p}speed <0.5-2.0>\` • \`${p}pitch <0.5-2.0>\` • \`${p}volume <1-150>\` (\`${p}vol\`) • \`${p}reset\``,
          ].join("\n"),
        },
        {
          name: "⚙️ 24/7 Radio, Modes & Admin Settings",
          value: [
            `\`${p}radio [station | search <genre> | URL | list | off]\` (\`${p}fm\`) — Continuous 24/7 live radio`,
            `\`${p}autoplay [on|off]\` (\`${p}ap\`) • \`${p}247 [on|off]\` (\`${p}stay\`)`,
            `\`${p}settings\` (\`${p}config\`) — Customize default volume, EQ, search platform & embed color`,
            `\`${p}nodes\` • \`${p}security\` • \`${p}emojis [refresh]\` — Admin/Owner tools`,
          ].join("\n"),
        },
      )
      .setFooter({
        text: `Tip: Force one platform anytime with yt:, ytm:, sp:, sc:, or dz: (e.g. ${p}play sc:lofi beats)`,
      });

    return message.reply({ embeds: [embed] });
  },
};

export const securityCommand = {
  name: "security",
  aliases: ["sec"],
  adminOnly: true,
  usage: "security",
  description: "[Admin] Show active security protections and hardening status",

  async execute(message, _args, { client, config, guildSettings }) {
    const nodes = [...client.lavalink.nodeManager.nodes.values()];
    const connected = nodes.filter((n) => n.connected);
    const allDave = connected.length > 0 && connected.every((n) => isDaveCompatible(n.info));
    const voteSkipOn = guildSettings ? guildSettings.isVoteSkip(message.guildId) : true;

    const checks = [
      `✅ **Prefix-Only Mode:** \`${config.prefix}\` (Slash commands ${config.clearSlashCommands ? "cleared & disabled" : "disabled"})`,
      `✅ **Admin Customization Lock:** Strictly requires a role with **Administrator** or **Manage Server** permission`,
      `✅ **Session Host & Vote-Skip:** ${voteSkipOn ? "ON (first VC summoner, track requester & admins skip instantly; others vote via `d!skip`)" : "OFF (toggle with `d!settings voteskip on`)"}`,
      `✅ **Mention Injection Guard:** \`@everyone\`, \`@here\`, and role pings blocked globally`,
      `✅ **SSRF / URL Guard:** Blocks localhost, private IPs, cloud metadata IPs, non-HTTP(S) schemes & unsafe redirects`,
      `✅ **Anti-Spam Rate Limit:** ${config.userCooldownMs / 1000}s cooldown • max ${config.maxCommandsPerWindow} cmds / 15s per user`,
      `✅ **Queue Flood Protection:** Capped at **${config.maxQueueSize}** tracks per server`,
      `✅ **Secret Redaction:** Bot token & node passwords stripped from error output`,
      `${allDave ? "✅" : "⚠️"} **Voice E2EE (DAVE):** ${connected.length} connected node(s), ${allDave ? "all DAVE v4.2+ verified" : "check d!nodes"}`,
      `${config.allowedGuildIds.size > 0 ? "🔒" : "ℹ️"} **Server Lock:** ${config.allowedGuildIds.size > 0 ? `Restricted to ${config.allowedGuildIds.size} server(s)` : "Open (set `ALLOWED_GUILD_IDS` in .env to lock to your server)"}`,
      `${config.allowedChannelIds.size > 0 ? "🔒" : "ℹ️"} **Channel Lock:** ${config.allowedChannelIds.size > 0 ? `Restricted to ${config.allowedChannelIds.size} channel(s)` : "All channels (set `ALLOWED_CHANNEL_IDS` in .env to restrict)"}`,
      `${config.requireDjRole ? "🔒" : "ℹ️"} **DJ Control Lock:** ${config.requireDjRole ? `Enabled (role: \`${config.djRoleName}\`)` : "Off (set `REQUIRE_DJ_ROLE=true` in .env to require DJ role)"}`,
    ];

    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle("🛡️ Bot Security Check")
      .setDescription(checks.join("\n"))
      .setFooter({
        text: `Servers: ${client.guilds.cache.size} • Active Players: ${client.lavalink.players.size}`,
      });

    return message.reply({ embeds: [embed] });
  },
};
