import { fileURLToPath } from "node:url";
import { REST, Routes } from "discord.js";
import { loadConfig } from "./config.js";

/**
 * Remove all registered global (and optional dev guild) slash commands
 * so the bot operates strictly in prefix-only (`d!`) mode.
 *
 * @param {{ token: string, clientId: string, guildId?: string }} options
 */
export async function clearSlashCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
  }
  console.log("[Commands] Cleared slash commands (running in prefix-only mode).");
}

// Allow running directly via `npm run clear-commands`
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();

if (isDirectRun) {
  const config = loadConfig();
  if (!config.discordToken) {
    console.error("Error: DISCORD_TOKEN is missing in .env");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const app = await rest.get(Routes.oauth2CurrentApplication());
  const clientId = app?.id;
  if (!clientId) {
    console.error("Error: Could not determine Discord Application ID from DISCORD_TOKEN.");
    process.exit(1);
  }

  await clearSlashCommands({
    token: config.discordToken,
    clientId,
    guildId: config.devGuildId || undefined,
  });
}
