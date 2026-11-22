import { EmbedBuilder } from "discord.js";
import {
  isDaveCompatible,
  parseServerVersion,
  pickFastestConnectedNode,
  recordNodeIssue,
} from "../services/nodeDiscovery.js";
import { COLORS, buildStatusEmbed } from "../ui/embeds.js";

export const nodesCommand = {
  name: "nodes",
  aliases: [],
  adminOnly: true,
  usage: "nodes [switch]",
  description: "[Admin] Inspect audio servers (ping, frame health, DAVE E2EE) or switch to another node",

  async execute(message, args, { client, config, refreshPublicNodes }) {
    const sub = (args[0] || "").toLowerCase();

    // `d!nodes switch` — migrate the active server player to another healthy node without losing the queue
    if (sub === "switch" || sub === "move") {
      const player = client.lavalink.getPlayer(message.guildId);
      if (!player) {
        return message.reply({
          embeds: [buildStatusEmbed("No active music session in this server to switch.", "info")],
        });
      }

      const oldId = player.node?.options?.id;
      recordNodeIssue(oldId);
      const otherNodes = [...client.lavalink.nodeManager.nodes.values()].filter(
        (n) => n.connected && n.options.id !== oldId,
      );

      if (otherNodes.length === 0) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              "No other connected audio server is currently available to switch to.",
              "warning",
            ),
          ],
        });
      }

      const best = pickFastestConnectedNode(client, { excludeNodeIds: oldId ? [oldId] : [] });
      const targetNode = best || otherNodes[0];
      const targetId = targetNode.options.id;
      try {
        if (typeof player.changeNode === "function") {
          await player.changeNode(targetNode, false);
        } else {
          await player.moveNode(targetId);
        }
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Switched audio server from **${oldId}** to **${targetId}** cleanly.`,
              "success",
            ),
          ],
        });
      } catch (err) {
        return message.reply({
          embeds: [buildStatusEmbed(`Could not switch node: ${err?.message || "Unknown error"}`, "error")],
        });
      }
    }

    const allNodes = [...client.lavalink.nodeManager.nodes.values()];

    if (allNodes.length === 0 && config.autoPublicNodes && refreshPublicNodes) {
      await refreshPublicNodes();
    }

    const activePlayer = client.lavalink.getPlayer(message.guildId);
    const activeNodeId = activePlayer?.node?.options?.id;
    const nodes = [...client.lavalink.nodeManager.nodes.values()];

    const lines = nodes.map((node) => {
      const status = node.connected ? "🟢 Online" : "🔴 Offline";
      const currentTag = node.options.id === activeNodeId ? " *(active here)*" : "";
      const version = parseServerVersion(node.info?.version).semver;
      const dave = node.info
        ? isDaveCompatible(node.info)
          ? "DAVE ✅"
          : "DAVE ⚠️ (<4.2)"
        : "DAVE ?";
      const ping =
        Number.isFinite(node.heartBeatPing) && node.heartBeatPing > 0
          ? `${node.heartBeatPing}ms`
          : "n/a";
      const players = node.stats?.playingPlayers ?? 0;
      const deficit = node.stats?.frameStats?.deficit ?? 0;
      const nulled = node.stats?.frameStats?.nulled ?? 0;
      const frameHealth = deficit === 0 && nulled === 0 ? "Clean" : `deficit=${deficit}, nulled=${nulled}`;
      const sources = Array.isArray(node.info?.sourceManagers)
        ? node.info.sourceManagers.slice(0, 7).join(", ")
        : "unknown";

      return [
        `**${node.options.id}**${currentTag} — ${status} • \`${node.nodeType} ${version}\` • ${dave}`,
        `Ping: \`${ping}\` • Streams: \`${players}\` • Frames: \`${frameHealth}\` • Sources: \`${sources}\``,
      ].join("\n");
    });

    const embed = new EmbedBuilder()
      .setColor(nodes.some((n) => n.connected) ? COLORS.SUCCESS : COLORS.ERROR)
      .setTitle("Audio Server (Lavalink) Status")
      .setDescription(
        (lines.length > 0
          ? lines.join("\n\n")
          : "_No Lavalink nodes configured or discovered yet._") +
          `\n\nTip: Run \`${config.prefix}nodes switch\` anytime to move playback to another audio server.`,
      )
      .setFooter({
        text: `Bot memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB • Public discovery: ${config.autoPublicNodes ? "ON" : "OFF"}`,
      });

    return message.reply({ embeds: [embed] });
  },
};
