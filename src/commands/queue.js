import {
  buildNowPlayingEmbed,
  buildPlayerControls,
  buildQueueEmbed,
  buildStatusEmbed,
} from "../ui/embeds.js";

export const queueCommand = {
  name: "queue",
  aliases: ["q"],
  usage: "queue [page]",
  description: "Show the current playback queue",

  async execute(message, args, { client, config, guildSettings }) {
    const player = client.lavalink.getPlayer(message.guildId);
    if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
      return message.reply({
        embeds: [
          buildStatusEmbed(`The queue is empty. Use \`${config.prefix}play\` to add music!`, "info"),
        ],
      });
    }

    const parsedPage = args[0] ? Number.parseInt(args[0], 10) : 1;
    const page = Number.isInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
    const themeColor = guildSettings?.get(message.guildId)?.themeColor ?? null;
    return message.reply({
      embeds: [buildQueueEmbed(player, page, 10, themeColor)],
    });
  },
};

export const nowPlayingCommand = {
  name: "nowplaying",
  aliases: ["np"],
  usage: "nowplaying",
  description: "Display the currently playing track with a live progress bar and controls",

  async execute(message, _args, { client, guildSettings }) {
    const player = client.lavalink.getPlayer(message.guildId);
    if (!player || !player.queue.current) {
      return message.reply({
        embeds: [buildStatusEmbed("Nothing is currently playing.", "info")],
      });
    }

    const prefs = guildSettings?.get(message.guildId) || {};
    return message.reply({
      embeds: [
        buildNowPlayingEmbed(player, player.queue.current, {
          showProgress: true,
          autoplay: prefs.autoplay,
          stay247: prefs.stay247,
          themeColor: prefs.themeColor,
        }),
      ],
      components: [buildPlayerControls(player)],
    });
  },
};
