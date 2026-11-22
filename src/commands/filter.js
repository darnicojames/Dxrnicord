import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  EQ_PRESETS,
  FILTER_PRESETS,
  applyEqToPlayer,
  applyFilterPreset,
  applySpeedPitchToPlayer,
  buildCustom3BandEQ,
  buildSliderEQ,
  getEqPresetBands,
  renderEqSummaryBar,
  resetAllFilters,
  resolveEqPresetKey,
  resolveFilterPresetKey,
} from "../services/audioPresets.js";
import { COLORS, buildStatusEmbed } from "../ui/embeds.js";
import { getTextEmoji } from "../ui/emojis.js";
import { requireActivePlayer } from "../utils/voiceChecks.js";

/**
 * `d!eq` — Interactive 15-band Equalizer with named presets, custom 3-band tuning, and dropdown picker.
 */
export const eqCommand = {
  name: "eq",
  aliases: ["equalizer"],
  usage: "eq [preset | custom <bass> <mid> <treble>]",
  description: "Apply equalizer presets (bassboost, trebleboost, vocal, pop, rock, edm, lofi, etc.) or tune custom bands",

  async execute(message, args, { client, config, guildSettings }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const { player } = check;
    const themeColor = guildSettings?.get(message.guildId)?.themeColor ?? COLORS.PRIMARY;
    const icon = getTextEmoji("filter");

    // 1. Custom 3-band tuning: `d!eq custom <bass> <mid> <treble>` (-5 to +10)
    if (args[0]?.toLowerCase() === "custom") {
      if (args.length < 4) {
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Usage: \`${config.prefix}eq custom <bass> <mid> <treble>\` (each from \`-5\` to \`10\`)\nExample: \`${config.prefix}eq custom 6 0 4\``,
              "info",
            ),
          ],
        });
      }

      const bass = Number(args[1]);
      const mid = Number(args[2]);
      const treble = Number(args[3]);
      if (![bass, mid, treble].every((n) => Number.isFinite(n) && n >= -5 && n <= 10)) {
        return message.reply({
          embeds: [buildStatusEmbed("Bass, Mid, and Treble values must each be between **-5** and **10**.", "warning")],
        });
      }

      const bands = buildCustom3BandEQ(bass, mid, treble);
      const label = `Custom (B:${bass} M:${mid} T:${treble})`;
      await applyEqToPlayer(player, bands, label);

      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle(`${icon} Custom Equalizer Applied`)
            .setDescription(`**${label}**\n\n${renderEqSummaryBar(bands)}`),
        ],
      });
    }

    // 2. Direct preset: `d!eq bassboost`, `d!eq treble`, `d!eq vocal`, `d!eq off`
    if (args[0]) {
      const key = resolveEqPresetKey(args[0]);
      if (!key) {
        const list = Object.keys(EQ_PRESETS)
          .map((k) => `\`${k}\``)
          .join(", ");
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Unknown EQ preset \`${args[0]}\`.\nAvailable presets: ${list}\nOr run \`${config.prefix}eq\` with no arguments for an interactive menu.`,
              "warning",
            ),
          ],
        });
      }

      const bands = getEqPresetBands(key);
      const preset = EQ_PRESETS[key];
      await applyEqToPlayer(player, bands, preset.name);

      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle(`${icon} Equalizer: ${preset.name}`)
            .setDescription(`${preset.description}\n\n${renderEqSummaryBar(bands)}`),
        ],
      });
    }

    // 3. No args -> show current live EQ visualizer + interactive dropdown menu!
    const currentLabel = player.getData("activeEqLabel") || "Flat (Off)";
    const currentBands = player.filterManager.equalizerBands || [];
    const customId = `eq_pick_${message.id}`;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose an Equalizer preset...")
      .addOptions(
        Object.entries(EQ_PRESETS).map(([key, preset]) => ({
          label: preset.name,
          description: preset.description.slice(0, 100),
          value: key,
        })),
      );

    const embed = new EmbedBuilder()
      .setColor(themeColor)
      .setTitle(`${icon} Equalizer`)
      .setDescription(
        `**Active EQ:** ${currentLabel}\n\n${renderEqSummaryBar(currentBands)}\n\n` +
          `Tip: Quick sliders \`${config.prefix}bb 0-10\` (bass), \`${config.prefix}tb 0-10\` (treble), or \`${config.prefix}eq custom <bass> <mid> <treble>\`.`,
      )
      .setFooter({ text: "Select a preset below within 30 seconds" });

    const sent = await message.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
    });

    try {
      const pick = await sent.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === message.author.id && i.customId === customId,
        time: 30_000,
      });

      const chosenKey = pick.values[0];
      const bands = getEqPresetBands(chosenKey);
      const preset = EQ_PRESETS[chosenKey];
      await applyEqToPlayer(player, bands, preset.name);

      await pick.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle(`${icon} Equalizer: ${preset.name}`)
            .setDescription(`${preset.description}\n\n${renderEqSummaryBar(bands)}`),
        ],
        components: [],
      });
    } catch {
      await sent.edit({ components: [] }).catch(() => {});
    }
  },
};

/**
 * `d!bassboost [0-10]` (`d!bb`) — Quick one-word bass slider.
 */
export const bassboostCommand = {
  name: "bassboost",
  aliases: ["bb", "bass"],
  usage: "bassboost [0-10]",
  description: "Quick bass boost toggle or intensity slider (0 = off, 1–10 = strength)",

  async execute(message, args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const { player } = check;
    let level;
    if (!args[0]) {
      const currentLabel = String(player.getData("activeEqLabel") || "");
      level = currentLabel.toLowerCase().includes("bass") ? 0 : 6;
    } else if (args[0].toLowerCase() === "off") {
      level = 0;
    } else {
      level = Number(args[0]);
      if (!Number.isFinite(level) || level < 0 || level > 10) {
        return message.reply({
          embeds: [buildStatusEmbed("Bass boost level must be between **0** (off) and **10**.", "warning")],
        });
      }
    }

    const bands = buildSliderEQ("bass", level);
    const label = level === 0 ? "Flat (Off)" : `Bass Boost (${level}/10)`;
    await applyEqToPlayer(player, bands, label);

    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(level === 0 ? COLORS.PRIMARY : COLORS.SUCCESS)
          .setTitle(level === 0 ? "Bass Boost Disabled" : `Bass Boost: ${level}/10`)
          .setDescription(renderEqSummaryBar(bands)),
      ],
    });
  },
};

/**
 * `d!treble [0-10]` (`d!tb`) — Quick one-word treble slider.
 */
export const trebleCommand = {
  name: "treble",
  aliases: ["tb", "trebleboost"],
  usage: "treble [0-10]",
  description: "Quick treble boost toggle or intensity slider (0 = off, 1–10 = strength)",

  async execute(message, args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const { player } = check;
    let level;
    if (!args[0]) {
      const currentLabel = String(player.getData("activeEqLabel") || "");
      level = currentLabel.toLowerCase().includes("treble") ? 0 : 6;
    } else if (args[0].toLowerCase() === "off") {
      level = 0;
    } else {
      level = Number(args[0]);
      if (!Number.isFinite(level) || level < 0 || level > 10) {
        return message.reply({
          embeds: [buildStatusEmbed("Treble boost level must be between **0** (off) and **10**.", "warning")],
        });
      }
    }

    const bands = buildSliderEQ("treble", level);
    const label = level === 0 ? "Flat (Off)" : `Treble Boost (${level}/10)`;
    await applyEqToPlayer(player, bands, label);

    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(level === 0 ? COLORS.PRIMARY : COLORS.SUCCESS)
          .setTitle(level === 0 ? "Treble Boost Disabled" : `Treble Boost: ${level}/10`)
          .setDescription(renderEqSummaryBar(bands)),
      ],
    });
  },
};

/**
 * `d!speed <0.5-2.0|reset>` — Fine-tune playback tempo independently.
 */
export const speedCommand = {
  name: "speed",
  aliases: [],
  usage: "speed <0.5-2.0|reset>",
  description: "Adjust playback speed (0.5x to 2.0x, or reset)",

  async execute(message, args, { client, config }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const raw = (args[0] || "").toLowerCase();
    if (!raw) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `Usage: \`${config.prefix}speed <0.5-2.0>\` or \`${config.prefix}speed reset\` (e.g. \`${config.prefix}speed 1.25\`)`,
            "info",
          ),
        ],
      });
    }

    const speed = raw === "reset" || raw === "off" ? 1.0 : Number(raw);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
      return message.reply({
        embeds: [buildStatusEmbed("Speed must be between **0.5** and **2.0** (1.0 = normal).", "warning")],
      });
    }

    await applySpeedPitchToPlayer(check.player, { speed });
    return message.reply({
      embeds: [buildStatusEmbed(`Playback speed set to **${speed.toFixed(2)}x**.`, "success")],
    });
  },
};

/**
 * `d!pitch <0.5-2.0|reset>` — Fine-tune musical pitch independently.
 */
export const pitchCommand = {
  name: "pitch",
  aliases: [],
  usage: "pitch <0.5-2.0|reset>",
  description: "Adjust musical pitch (0.5x to 2.0x, or reset)",

  async execute(message, args, { client, config }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const raw = (args[0] || "").toLowerCase();
    if (!raw) {
      return message.reply({
        embeds: [
          buildStatusEmbed(
            `Usage: \`${config.prefix}pitch <0.5-2.0>\` or \`${config.prefix}pitch reset\` (e.g. \`${config.prefix}pitch 1.15\`)`,
            "info",
          ),
        ],
      });
    }

    const pitch = raw === "reset" || raw === "off" ? 1.0 : Number(raw);
    if (!Number.isFinite(pitch) || pitch < 0.5 || pitch > 2.0) {
      return message.reply({
        embeds: [buildStatusEmbed("Pitch must be between **0.5** and **2.0** (1.0 = normal).", "warning")],
      });
    }

    await applySpeedPitchToPlayer(check.player, { pitch });
    return message.reply({
      embeds: [buildStatusEmbed(`Audio pitch set to **${pitch.toFixed(2)}x**.`, "success")],
    });
  },
};

/**
 * `d!resetfx` (`d!reset`) — Reset all EQ, speed, pitch, and audio effects back to studio default.
 */
export const resetFxCommand = {
  name: "resetfx",
  aliases: ["reset"],
  usage: "resetfx",
  description: "Clear all active equalizer bands, speed, pitch, and audio effects",

  async execute(message, _args, { client }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    await resetAllFilters(check.player);
    return message.reply({
      embeds: [buildStatusEmbed("All equalizer settings, speed, pitch, and audio effects reset to default.", "success")],
    });
  },
};

/**
 * `d!filter [preset]` (`d!fx`, `d!effect`) — Audio effects + interactive dropdown menu!
 */
export const filterCommand = {
  name: "filter",
  aliases: ["fx", "effect"],
  usage: "filter [preset]",
  description: "Apply audio effects (nightcore, daycore, vaporwave, 8d, lofi, karaoke, vibrato, tremolo, chipmunk, deep)",

  async execute(message, args, { client, guildSettings }) {
    const check = requireActivePlayer(message, client);
    if (!check.ok) {
      return message.reply({ embeds: [buildStatusEmbed(check.error, "warning")] });
    }

    const { player } = check;
    const themeColor = guildSettings?.get(message.guildId)?.themeColor ?? COLORS.PRIMARY;
    const icon = getTextEmoji("filter");

    // Direct preset
    if (args[0]) {
      const key = resolveFilterPresetKey(args[0]);
      if (!key) {
        const list = Object.keys(FILTER_PRESETS)
          .map((k) => `\`${k}\``)
          .join(", ");
        return message.reply({
          embeds: [
            buildStatusEmbed(
              `Unknown filter \`${args[0]}\`.\nAvailable effects: ${list}`,
              "warning",
            ),
          ],
        });
      }

      const summary = await applyFilterPreset(player, key);
      return message.reply({ embeds: [buildStatusEmbed(`${icon} ${summary}`, "success")] });
    }

    // No args -> interactive effect dropdown!
    const currentFilter = player.getData("activeFilterLabel") || "None";
    const customId = `fx_pick_${message.id}`;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose an audio effect...")
      .addOptions(
        Object.entries(FILTER_PRESETS).map(([key, info]) => ({
          label: info.label,
          description: info.description.slice(0, 100),
          value: key,
        })),
      );

    const embed = new EmbedBuilder()
      .setColor(themeColor)
      .setTitle(`${icon} Audio Effects`)
      .setDescription(`**Active Effect:** ${currentFilter}\nPick an effect below to apply immediately.`)
      .setFooter({ text: "Select an effect within 30 seconds" });

    const sent = await message.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
    });

    try {
      const pick = await sent.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === message.author.id && i.customId === customId,
        time: 30_000,
      });

      const summary = await applyFilterPreset(player, pick.values[0]);
      await pick.update({
        embeds: [buildStatusEmbed(`${icon} ${summary}`, "success")],
        components: [],
      });
    } catch {
      await sent.edit({ components: [] }).catch(() => {});
    }
  },
};
