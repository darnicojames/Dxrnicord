import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { LavalinkManager } from "lavalink-client";
import { loadConfig } from "./config.js";
import { clearSlashCommands } from "./deploy-commands.js";
import { registerInteractionHandler } from "./events/interactionHandler.js";
import { registerLavalinkEvents } from "./events/lavalinkEvents.js";
import { registerMessageHandler } from "./events/messageHandler.js";
import { RateLimiter, redactSecrets } from "./security/guard.js";
import { createAutoplayHandler } from "./services/autoplay.js";
import { GuildSettingsStore } from "./services/guildSettings.js";
import { startHealthServer } from "./services/healthServer.js";
import { resolveStartupNodes } from "./services/nodeDiscovery.js";
import { formatServerCountStatus } from "./services/voiceStatus.js";
import { loadAppEmojis } from "./ui/emojis.js";
import { VoiceReadinessTracker } from "./utils/voiceReady.js";

function updateServerCountPresence(client, config) {
  if (!client.user) return;
  const text = formatServerCountStatus(client.guilds.cache.size, config.prefix);
  client.user.setPresence({
    activities: [{ name: text, type: ActivityType.Watching }],
    status: "online",
  });
}

async function main() {
  const config = loadConfig();

  if (!config.discordToken) {
    console.error(
      "[Startup] Missing DISCORD_TOKEN. Copy .env.example to .env (or set DISCORD_TOKEN in your host's environment variables).",
    );
    process.exit(1);
  }

  const startupNodes = await resolveStartupNodes(config);
  const guildSettings = new GuildSettingsStore();
  const voiceTracker = new VoiceReadinessTracker();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Security: block @everyone, @here, and role mention injection globally
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  });

  client.lavalink = new LavalinkManager({
    nodes: startupNodes,
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard?.send(payload);
    },
    autoSkip: true,
    autoMove: true,
    autoSkipOnResolveError: true,
    catchLifeCycleRejections: true,
    playerOptions: {
      defaultSearchPlatform: config.defaultSearchPlatform,
      enforceSponsorBlockRequestForEventEnablement: false,
      maxErrorsPerTime: {
        threshold: 35_000,
        maxAmount: 8,
      },
      onDisconnect: {
        autoReconnect: true,
        autoReconnectOnlyWithTracks: true,
        destroyPlayer: false,
      },
      onEmptyQueue: {
        autoPlayFunction: createAutoplayHandler({ config, guildSettings }),
      },
      useUnresolvedData: true,
    },
    queueOptions: {
      maxPreviousTracks: 20,
    },
  });

  const rateLimiter = new RateLimiter({
    cooldownMs: config.userCooldownMs,
    windowMs: 15_000,
    maxPerWindow: config.maxCommandsPerWindow,
  });

  // Refresh public Lavalink nodes on demand if all existing nodes are offline
  let refreshing = false;
  const refreshPublicNodes = async () => {
    if (!config.autoPublicNodes || refreshing || !client.lavalink.initiated) return;
    refreshing = true;
    try {
      const freshNodes = await resolveStartupNodes({ ...config, customNodes: [] });
      for (const nodeOpts of freshNodes) {
        const exists = [...client.lavalink.nodeManager.nodes.values()].some(
          (n) =>
            n.options.host.toLowerCase() === nodeOpts.host.toLowerCase() &&
            n.options.port === nodeOpts.port,
        );
        if (!exists) {
          const created = client.lavalink.nodeManager.createNode(nodeOpts);
          created.connect();
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.warn(`[Nodes] Public node refresh failed: ${err?.message || err}`);
    } finally {
      refreshing = false;
    }
  };

  // Forward Discord voice gateway packets (VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE) to Lavalink
  client.on(Events.Raw, (packet) => {
    const guildId = packet?.d?.guild_id;
    client.lavalink
      .sendRawData(packet)
      .then(() => {
        if (packet?.t === "VOICE_SERVER_UPDATE" && guildId) {
          voiceTracker.markVoiceRelayed(guildId);
        }
      })
      .catch(() => {});
  });

  // Security: auto-leave unauthorized servers if ALLOWED_GUILD_IDS is configured & refresh server count status
  client.on(Events.GuildCreate, async (guild) => {
    if (
      config.allowedGuildIds.size > 0 &&
      !config.allowedGuildIds.has(guild.id) &&
      config.leaveUnauthorizedGuilds
    ) {
      console.warn(`[Security] Leaving unauthorized server "${guild.name}" (${guild.id}).`);
      await guild.leave().catch(() => {});
      return;
    }
    updateServerCountPresence(client, config);
  });

  client.on(Events.GuildDelete, () => {
    updateServerCountPresence(client, config);
  });

  const sharedContext = {
    client,
    config,
    rateLimiter,
    guildSettings,
    voiceTracker,
    refreshPublicNodes,
  };
  registerLavalinkEvents(client, config, guildSettings, voiceTracker);
  registerMessageHandler(client, sharedContext);
  registerInteractionHandler(client, sharedContext);

  const health = await startHealthServer(config.healthPort, () => {
    const nodes = [...client.lavalink.nodeManager.nodes.values()];
    return {
      botTag: client.user?.tag || "starting",
      prefix: config.prefix,
      guilds: client.guilds.cache.size,
      activePlayers: client.lavalink.players.size,
      connectedNodes: nodes.filter((n) => n.connected).length,
      totalNodes: nodes.length,
    };
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(
      `[Discord] Logged in as ${readyClient.user.tag} across ${readyClient.guilds.cache.size} server(s). Prefix: "${config.prefix}"`,
    );

    // Enforce server allowlist on startup too
    if (config.allowedGuildIds.size > 0 && config.leaveUnauthorizedGuilds) {
      for (const guild of readyClient.guilds.cache.values()) {
        if (!config.allowedGuildIds.has(guild.id)) {
          console.warn(`[Security] Leaving unauthorized server "${guild.name}" (${guild.id}).`);
          await guild.leave().catch(() => {});
        }
      }
    }

    // Set emoji-free server count status
    updateServerCountPresence(readyClient, config);

    // Load custom App Emojis uploaded in Discord Developer Portal -> Emojis
    const emojiCount = await loadAppEmojis(readyClient);
    console.log(`[Emojis] Loaded ${emojiCount} custom App Emoji(s).`);

    await client.lavalink.init({
      id: readyClient.user.id,
      username: readyClient.user.username,
    });

    if (config.clearSlashCommands) {
      try {
        await clearSlashCommands({
          token: config.discordToken,
          clientId: readyClient.user.id,
          guildId: config.devGuildId || undefined,
        });
      } catch (err) {
        console.warn("[Commands] Could not clear old slash commands:", err?.message || err);
      }
    }

    console.log(
      `[Security] Guards active: prefix-only="${config.prefix}", SSRF=ON, mention-guard=ON, rate-limit=${config.userCooldownMs}ms/${config.maxCommandsPerWindow}-per-15s, max-queue=${config.maxQueueSize}, server-lock=${config.allowedGuildIds.size || "OFF"}, dj-lock=${config.requireDjRole ? "ON" : "OFF"}`,
    );
  });

  // Periodic background recovery if every public node goes offline
  const recoveryInterval = setInterval(() => {
    if (config.autoPublicNodes && client.lavalink.initiated && !client.lavalink.useable) {
      console.warn("[Nodes] All audio nodes offline — attempting automatic public node refresh...");
      refreshPublicNodes();
    }
  }, 5 * 60 * 1000);
  recoveryInterval.unref();

  const shutdown = async (signal) => {
    console.log(`[Shutdown] Received ${signal}. Cleaning up...`);
    clearInterval(recoveryInterval);
    try {
      await client.lavalink.nodeManager.disconnectAll(false, true);
    } catch {
      // ignore during exit
    }
    await health.close();
    client.destroy();
    process.exit(0);
  };

  const secrets = [config.discordToken, config.spotifyClientSecret].filter(Boolean);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("[Process] Unhandled Rejection:", redactSecrets(String(reason), secrets));
  });
  process.on("uncaughtException", (err) => {
    console.error("[Process] Uncaught Exception:", redactSecrets(err?.stack || String(err), secrets));
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  console.error("[Startup] Fatal error:", err?.message || err);
  process.exit(1);
});
