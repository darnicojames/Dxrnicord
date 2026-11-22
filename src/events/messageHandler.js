import { Events } from "discord.js";
import { commandLookup, parsePrefixCommand } from "../commands/index.js";
import { checkAccess, redactSecrets } from "../security/guard.js";
import { buildStatusEmbed } from "../ui/embeds.js";

/**
 * Collect runtime secrets so they can never accidentally leak into logs or Discord replies.
 */
function collectSecrets(config, client) {
  const secrets = [config.discordToken, config.spotifyClientSecret];
  for (const node of client.lavalink?.nodeManager?.nodes?.values() || []) {
    if (node?.options?.authorization) secrets.push(node.options.authorization);
  }
  return secrets.filter(Boolean);
}

/**
 * Handle prefix-only (default: d!) Discord text commands with full security checks.
 */
export function registerMessageHandler(client, context) {
  const { config, rateLimiter } = context;

  client.on(Events.MessageCreate, async (message) => {
    try {
      // Ignore DMs, bots, and webhooks
      if (!message.inGuild() || message.author.bot || message.webhookId) return;

      const parsed = parsePrefixCommand(message.content, config.prefix);
      if (!parsed) return;

      const command = commandLookup.get(parsed.name);
      if (!command) return;

      const player = client.lavalink.getPlayer(message.guildId);
      const voiceChannel = message.member?.voice?.channel || null;

      // 1. Access control (server allowlist, channel lock, user allowlist, admin-only, DJ role)
      const access = checkAccess({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        member: message.member,
        voiceChannel,
        player,
        commandName: command.name,
        config,
      });

      if (!access.ok) {
        if (!access.silent) {
          await message
            .reply({ embeds: [buildStatusEmbed(`🛡️ ${access.error}`, "warning")] })
            .catch(() => {});
        }
        return;
      }

      // 2. Per-user anti-spam rate limiter
      const limit = rateLimiter.check(message.author.id);
      if (!limit.allowed) {
        const waitSec = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
        await message
          .reply({
            embeds: [
              buildStatusEmbed(
                `⏱️ Slow down — please wait **${waitSec}s** before running another command.`,
                "warning",
              ),
            ],
          })
          .catch(() => {});
        return;
      }

      // 3. Execute command
      await command.execute(message, parsed.args, context);
    } catch (err) {
      const secrets = collectSecrets(config, client);
      const safeMsg = redactSecrets(err?.message || "Unexpected error", secrets);
      console.error("[Command] Error:", redactSecrets(err?.stack || safeMsg, secrets));

      await message
        .reply({
          embeds: [buildStatusEmbed(`Something went wrong: ${safeMsg}`, "error")],
        })
        .catch(() => {});
    }
  });
}
