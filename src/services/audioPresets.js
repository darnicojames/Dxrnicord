/**
 * Studio-tuned 15-band Lavalink Equalizer presets, 3-band custom EQ mapper,
 * bass/treble sliders, audio effect presets, and server theme colors.
 *
 * Lavalink 15 bands:
 *  0: 25Hz   1: 40Hz   2: 63Hz   3: 100Hz  4: 160Hz  (Bass)
 *  5: 250Hz  6: 400Hz  7: 630Hz  8: 1kHz   9: 1.6kHz (Mids)
 * 10: 2.5kHz 11: 4kHz  12: 6.3kHz 13: 10kHz 14: 16kHz (Treble)
 */

function toBands(gains) {
  return gains.map((gain, band) => ({
    band,
    gain: Math.round(Math.min(0.65, Math.max(-0.25, gain)) * 1000) / 1000,
  }));
}

export const EQ_PRESETS = {
  off: {
    name: "Flat (Off)",
    description: "Neutral studio sound — clears all EQ adjustments",
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  bassboost: {
    name: "Bass Boost",
    description: "Warm, punchy low-end boost without muddy mids",
    gains: [0.24, 0.22, 0.18, 0.12, 0.05, 0, 0, 0, 0, 0, 0, 0.02, 0.04, 0.04, 0.02],
  },
  superbass: {
    name: "Super Bass",
    description: "Heavy club sub-bass punch",
    gains: [0.42, 0.38, 0.3, 0.2, 0.08, -0.04, -0.04, 0, 0, 0, 0.02, 0.04, 0.06, 0.05, 0.02],
  },
  trebleboost: {
    name: "Treble Boost",
    description: "Crisp highs, bright cymbals, and vocal air",
    gains: [-0.04, -0.02, 0, 0, 0, 0, 0.02, 0.04, 0.08, 0.14, 0.2, 0.26, 0.3, 0.28, 0.24],
  },
  vocal: {
    name: "Vocal Boost",
    description: "Clear, forward vocals with gentle bass trim",
    gains: [-0.1, -0.08, -0.05, -0.02, 0, 0.04, 0.1, 0.16, 0.22, 0.24, 0.18, 0.1, 0.04, 0, -0.02],
  },
  pop: {
    name: "Pop",
    description: "Modern V-shaped polish — punchy bass & sparkling highs",
    gains: [0.14, 0.12, 0.08, 0.02, -0.02, -0.04, 0, 0.04, 0.08, 0.1, 0.12, 0.14, 0.16, 0.14, 0.1],
  },
  rock: {
    name: "Rock",
    description: "Tight low punch, aggressive guitars, crisp cymbals",
    gains: [0.18, 0.14, 0.1, 0.04, -0.04, -0.08, -0.04, 0.04, 0.1, 0.14, 0.18, 0.2, 0.16, 0.12, 0.08],
  },
  electronic: {
    name: "Electronic / EDM",
    description: "Deep sub-bass drop + crisp synths & hi-hats",
    gains: [0.28, 0.24, 0.16, 0.06, -0.04, -0.06, 0, 0.04, 0.08, 0.1, 0.14, 0.2, 0.24, 0.22, 0.16],
  },
  classical: {
    name: "Classical",
    description: "Balanced acoustic warmth with airy strings",
    gains: [0.06, 0.05, 0.04, 0.02, 0, 0, 0, 0, 0.02, 0.04, 0.08, 0.12, 0.14, 0.12, 0.1],
  },
  soft: {
    name: "Soft / Chill",
    description: "Smooth, mellow tone with softened harsh highs",
    gains: [0.08, 0.06, 0.04, 0.02, 0.02, 0.04, 0.02, 0, -0.02, -0.04, -0.08, -0.1, -0.12, -0.14, -0.16],
  },
  lofi: {
    name: "Lo-Fi Warmth",
    description: "Cozy vintage vinyl curve with warm lows and rolled-off highs",
    gains: [0.12, 0.14, 0.12, 0.08, 0.06, 0.04, 0.02, -0.02, -0.06, -0.1, -0.14, -0.18, -0.22, -0.24, -0.25],
  },
};

export const EQ_ALIASES = {
  flat: "off",
  reset: "off",
  none: "off",
  bass: "bassboost",
  bb: "bassboost",
  heavybass: "superbass",
  club: "superbass",
  treble: "trebleboost",
  tb: "trebleboost",
  highs: "trebleboost",
  vocals: "vocal",
  voice: "vocal",
  edm: "electronic",
  dance: "electronic",
  chill: "soft",
};

/**
 * Resolve an EQ preset key or alias to canonical preset name, or null if unknown.
 * @param {string} raw
 */
export function resolveEqPresetKey(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return null;
  if (EQ_PRESETS[key]) return key;
  return EQ_ALIASES[key] || null;
}

/**
 * Return the 15 Lavalink EQBand objects for a named preset.
 * @param {string} presetKey
 */
export function getEqPresetBands(presetKey) {
  const canonical = resolveEqPresetKey(presetKey);
  if (!canonical) return null;
  return toBands(EQ_PRESETS[canonical].gains);
}

/**
 * Map simple 3-band levels (`-5` to `+10` for Bass, Mid, Treble) smoothly onto 15 Lavalink EQ bands.
 * @param {number} bassLevel
 * @param {number} midLevel
 * @param {number} trebleLevel
 */
export function buildCustom3BandEQ(bassLevel, midLevel, trebleLevel) {
  const clamp = (v) => Math.min(10, Math.max(-5, Number(v) || 0));
  const b = clamp(bassLevel) * 0.045; // -0.225 .. +0.45
  const m = clamp(midLevel) * 0.035; // -0.175 .. +0.35
  const t = clamp(trebleLevel) * 0.042; // -0.21  .. +0.42

  const gains = [
    b * 1.0, // 25Hz
    b * 0.95, // 40Hz
    b * 0.85, // 63Hz
    b * 0.65, // 100Hz
    b * 0.4 + m * 0.3, // 160Hz
    m * 0.75, // 250Hz
    m * 0.95, // 400Hz
    m * 1.0, // 630Hz
    m * 0.95, // 1kHz
    m * 0.7 + t * 0.3, // 1.6kHz
    t * 0.65, // 2.5kHz
    t * 0.85, // 4kHz
    t * 1.0, // 6.3kHz
    t * 0.95, // 10kHz
    t * 0.85, // 16kHz
  ];

  return toBands(gains);
}

/**
 * Build a clean slider EQ curve for quick `d!bb <0-10>` or `d!tb <0-10>` commands.
 * @param {"bass" | "treble"} mode
 * @param {number} level 0..10
 */
export function buildSliderEQ(mode, level) {
  const clamped = Math.min(10, Math.max(0, Number(level) || 0));
  if (clamped === 0) return toBands(EQ_PRESETS.off.gains);
  return mode === "bass"
    ? buildCustom3BandEQ(clamped, 0, 0)
    : buildCustom3BandEQ(0, 0, clamped);
}

/**
 * Render a compact ASCII 3-zone (Bass / Mid / Treble) visual indicator from 15 EQ bands.
 * @param {Array<{ band: number, gain: number }>} bands
 */
export function renderEqSummaryBar(bands = []) {
  const gainByBand = new Array(15).fill(0);
  for (const b of bands) {
    if (b && b.band >= 0 && b.band < 15) gainByBand[b.band] = Number(b.gain) || 0;
  }

  const avg = (slice) => slice.reduce((a, c) => a + c, 0) / slice.length;
  const toBar = (gain) => {
    // Map -0.25..+0.45 to 0..10 blocks
    const filled = Math.min(10, Math.max(0, Math.round(((gain + 0.25) / 0.7) * 10)));
    const db = Math.round(gain * 24);
    const sign = db > 0 ? "+" : "";
    return `${"█".repeat(filled)}${"░".repeat(10 - filled)} (${sign}${db} dB)`;
  };

  const bassAvg = avg(gainByBand.slice(0, 5));
  const midAvg = avg(gainByBand.slice(5, 10));
  const trebleAvg = avg(gainByBand.slice(10, 15));

  return [
    `\`Bass  \` ${toBar(bassAvg)}`,
    `\`Mids  \` ${toBar(midAvg)}`,
    `\`Treble\` ${toBar(trebleAvg)}`,
  ].join("\n");
}

/**
 * Send the complete filter payload to Lavalink in ONE SINGLE atomic REST request,
 * and include `position: player.position` on seekable tracks to immediately flush
 * Lavalink's 5-10s Opus frame buffer (making filters audible in ~0.3s instead of 10s!).
 *
 * @param {any} player
 * @param {Record<string, any>} nextFilters
 */
export async function commitFiltersInstantly(player, nextFilters) {
  const payload = { ...nextFilters };
  player.setData("activeFiltersPayload", payload);

  // Keep FilterManager's local EQ cache in sync for the live visualizer
  if (player.filterManager) {
    player.filterManager.equalizerBands = Array.isArray(payload.equalizer)
      ? [...payload.equalizer]
      : [];
  }

  // Only pass filters supported by the active node (case-insensitive for Lavalink + NodeLink compatibility)
  const supported = Array.isArray(player?.node?.info?.filters)
    ? new Set(player.node.info.filters.map((f) => String(f).toLowerCase()))
    : null;
  const filteredPayload = {};
  for (const [key, val] of Object.entries(payload)) {
    if (!supported || supported.has(key.toLowerCase())) {
      filteredPayload[key] = val;
    }
  }

  const current = player.queue?.current;
  const canFlushBuffer = Boolean(
    player.playing &&
      current &&
      !current.info?.isStream &&
      current.info?.isSeekable &&
      Number.isFinite(player.position) &&
      player.position >= 0 &&
      (!current.info?.duration || player.position < current.info.duration - 1500),
  );

  const playerOptions = { filters: filteredPayload };
  if (canFlushBuffer) {
    playerOptions.position = Math.max(0, Math.floor(player.position));
  }

  if (player?.node?.updatePlayer) {
    await player.node.updatePlayer({
      guildId: player.guildId,
      playerOptions,
    });
    return;
  }

  // Fallback for minimal mock players in tests
  if (player.filterManager) {
    if (Object.keys(filteredPayload).length === 0 && player.filterManager.resetFilters) {
      await player.filterManager.resetFilters();
    } else if (filteredPayload.equalizer && player.filterManager.setEQ) {
      await player.filterManager.setEQ(filteredPayload.equalizer);
    } else if (!filteredPayload.equalizer && player.filterManager.clearEQ) {
      await player.filterManager.clearEQ();
    }
  }
}

/**
 * Apply an EQ band array cleanly in a single instant PATCH (preserving other active effects).
 */
export async function applyEqToPlayer(player, bands, label) {
  const currentFilters = { ...(player.getData("activeFiltersPayload") || {}) };
  const isFlat = bands.every((b) => Math.abs(b.gain) < 0.001);

  if (isFlat) {
    delete currentFilters.equalizer;
    player.setData("activeEqLabel", "Flat (Off)");
  } else {
    currentFilters.equalizer = bands;
    player.setData("activeEqLabel", label);
  }

  await commitFiltersInstantly(player, currentFilters);
}

/**
 * Adjust playback speed and/or pitch independently in a single instant PATCH (preserving active EQ).
 * @param {any} player
 * @param {{ speed?: number, pitch?: number }} changes
 */
export async function applySpeedPitchToPlayer(player, { speed, pitch }) {
  const currentFilters = { ...(player.getData("activeFiltersPayload") || {}) };
  const prevTs = currentFilters.timescale || { speed: 1.0, pitch: 1.0, rate: 1.0 };
  const nextTs = {
    speed: speed ?? prevTs.speed ?? 1.0,
    pitch: pitch ?? prevTs.pitch ?? 1.0,
    rate: prevTs.rate ?? 1.0,
  };

  if (
    Math.abs(nextTs.speed - 1.0) < 0.001 &&
    Math.abs(nextTs.pitch - 1.0) < 0.001 &&
    Math.abs(nextTs.rate - 1.0) < 0.001
  ) {
    delete currentFilters.timescale;
  } else {
    currentFilters.timescale = nextTs;
  }

  await commitFiltersInstantly(player, currentFilters);
}

/**
 * Reset ALL active filters, EQ, speed, and pitch in one instant PATCH.
 */
export async function resetAllFilters(player) {
  player.setData("activeEqLabel", "Flat (Off)");
  player.setData("activeFilterLabel", "None");
  await commitFiltersInstantly(player, {});
}

export const FILTER_PRESETS = {
  off: { label: "Off (Reset All)", description: "Clear all effects, speed, pitch, and EQ" },
  nightcore: { label: "Nightcore", description: "Faster tempo + higher pitch (1.25x)" },
  daycore: { label: "Daycore / Slowed", description: "Slowed down + deeper pitch (0.85x)" },
  vaporwave: { label: "Vaporwave", description: "Dreamy slowed & pitched retro vibe" },
  "8d": { label: "8D Audio", description: "Rotating spatial surround effect" },
  lofi: { label: "Lo-Fi Radio", description: "Warm low-pass filter + cozy vinyl EQ" },
  karaoke: { label: "Karaoke", description: "Reduces center-channel lead vocals" },
  vibrato: { label: "Vibrato", description: "Wavy pitch modulation effect" },
  tremolo: { label: "Tremolo", description: "Rhythmic pulsing volume wave" },
  chipmunk: { label: "Chipmunk", description: "High-pitched vocals at normal speed" },
  deep: { label: "Deep Voice", description: "Deep low-pitched sound at normal speed" },
};

export const FILTER_ALIASES = {
  reset: "off",
  clear: "off",
  slowed: "daycore",
  slow: "daycore",
  darth: "deep",
};

export function resolveFilterPresetKey(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return null;
  if (FILTER_PRESETS[key]) return key;
  return FILTER_ALIASES[key] || null;
}

/**
 * Apply one of the named audio effect presets in ONE atomic instant PATCH (zero multi-call lag!).
 */
export async function applyFilterPreset(player, presetKey) {
  player.setData("activeEqLabel", "Flat (Off)");

  switch (presetKey) {
    case "off":
      player.setData("activeFilterLabel", "None");
      await commitFiltersInstantly(player, {});
      return "Cleared all audio effects, speed, pitch, and EQ.";
    case "nightcore":
      player.setData("activeFilterLabel", "Nightcore");
      await commitFiltersInstantly(player, {
        timescale: { speed: 1.25, pitch: 1.25, rate: 1.0 },
      });
      return "Applied **Nightcore** effect.";
    case "daycore":
      player.setData("activeFilterLabel", "Daycore / Slowed");
      await commitFiltersInstantly(player, {
        timescale: { speed: 0.85, pitch: 0.85, rate: 1.0 },
      });
      return "Applied **Daycore / Slowed** effect.";
    case "vaporwave":
      player.setData("activeFilterLabel", "Vaporwave");
      await commitFiltersInstantly(player, {
        timescale: { speed: 0.85, pitch: 0.8, rate: 1.0 },
      });
      return "Applied **Vaporwave** effect.";
    case "8d":
      player.setData("activeFilterLabel", "8D Audio");
      await commitFiltersInstantly(player, {
        rotation: { rotationHz: 0.2 },
      });
      return "Applied **8D Audio** surround rotation.";
    case "lofi":
      player.setData("activeEqLabel", "Lo-Fi Warmth");
      player.setData("activeFilterLabel", "Lo-Fi Radio");
      await commitFiltersInstantly(player, {
        lowPass: { smoothing: 20 },
        equalizer: getEqPresetBands("lofi"),
      });
      return "Applied **Lo-Fi Radio** effect (low-pass + warm EQ).";
    case "karaoke":
      player.setData("activeFilterLabel", "Karaoke");
      await commitFiltersInstantly(player, {
        karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220, filterWidth: 100 },
      });
      return "Applied **Karaoke** vocal reduction.";
    case "vibrato":
      player.setData("activeFilterLabel", "Vibrato");
      await commitFiltersInstantly(player, {
        vibrato: { frequency: 4.0, depth: 0.5 },
      });
      return "Applied **Vibrato** effect.";
    case "tremolo":
      player.setData("activeFilterLabel", "Tremolo");
      await commitFiltersInstantly(player, {
        tremolo: { frequency: 4.0, depth: 0.5 },
      });
      return "Applied **Tremolo** effect.";
    case "chipmunk":
      player.setData("activeFilterLabel", "Chipmunk");
      await commitFiltersInstantly(player, {
        timescale: { speed: 1.0, pitch: 1.45, rate: 1.0 },
      });
      return "Applied **Chipmunk** pitch effect.";
    case "deep":
      player.setData("activeFilterLabel", "Deep Voice");
      await commitFiltersInstantly(player, {
        timescale: { speed: 1.0, pitch: 0.72, rate: 1.0 },
      });
      return "Applied **Deep Voice** pitch effect.";
    default:
      throw new Error(`Unknown filter preset: ${presetKey}`);
  }
}

export const NAMED_THEME_COLORS = {
  default: null,
  blurple: 0x5865f2,
  frog: 0x4caf50,
  green: 0x2ecc71,
  spotify: 0x1db954,
  crimson: 0xe74c3c,
  gold: 0xf1c40f,
  cyan: 0x00bcd4,
  purple: 0x9b59b6,
  pink: 0xff6b9d,
  mint: 0x3eb489,
  orange: 0xff7043,
};

/**
 * Parse a named color (`frog`, `purple`, `default`) or hex string (`#2ecc71`) into a Discord integer color.
 * Returns `{ ok: true, color: number | null, label: string }` or `{ ok: false }`.
 */
export function parseThemeColor(raw) {
  const input = String(raw || "").trim().toLowerCase();
  if (!input) return { ok: false };

  if (Object.hasOwn(NAMED_THEME_COLORS, input)) {
    return { ok: true, color: NAMED_THEME_COLORS[input], label: input };
  }

  const hexMatch = input.match(/^#?([0-9a-f]{6})$/i);
  if (hexMatch) {
    return {
      ok: true,
      color: Number.parseInt(hexMatch[1], 16),
      label: `#${hexMatch[1].toUpperCase()}`,
    };
  }

  return { ok: false };
}
