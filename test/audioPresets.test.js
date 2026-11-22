import assert from "node:assert/strict";
import test from "node:test";
import {
  EQ_PRESETS,
  FILTER_PRESETS,
  applyEqToPlayer,
  applyFilterPreset,
  applySpeedPitchToPlayer,
  buildCustom3BandEQ,
  buildSliderEQ,
  getEqPresetBands,
  parseThemeColor,
  renderEqSummaryBar,
  resetAllFilters,
  resolveEqPresetKey,
  resolveFilterPresetKey,
} from "../src/services/audioPresets.js";

test("all EQ presets produce 15 safe Lavalink EQ bands within [-0.25, 0.65]", () => {
  for (const key of Object.keys(EQ_PRESETS)) {
    const bands = getEqPresetBands(key);
    assert.equal(bands.length, 15, `Preset ${key} must define all 15 bands`);
    for (let i = 0; i < 15; i++) {
      assert.equal(bands[i].band, i);
      assert.ok(bands[i].gain >= -0.25 && bands[i].gain <= 0.65);
    }
  }

  assert.equal(resolveEqPresetKey("bass"), "bassboost");
  assert.equal(resolveEqPresetKey("treble"), "trebleboost");
  assert.equal(resolveEqPresetKey("edm"), "electronic");
  assert.equal(resolveEqPresetKey("flat"), "off");
  assert.equal(resolveEqPresetKey("nonexistent"), null);
});

test("buildCustom3BandEQ and buildSliderEQ map Bass/Mid/Treble cleanly onto 15 bands", () => {
  const custom = buildCustom3BandEQ(8, -2, 6);
  assert.equal(custom.length, 15);
  assert.ok(custom[0].gain > 0.25); // bass lifted
  assert.ok(custom[7].gain < 0); // mids dipped
  assert.ok(custom[12].gain > 0.2); // treble lifted

  const bassSlider = buildSliderEQ("bass", 7);
  assert.ok(bassSlider[0].gain > 0.2);
  assert.equal(bassSlider[13].gain, 0);

  const trebleSlider = buildSliderEQ("treble", 7);
  assert.equal(trebleSlider[0].gain, 0);
  assert.ok(trebleSlider[12].gain > 0.2);

  const offSlider = buildSliderEQ("bass", 0);
  assert.ok(offSlider.every((b) => b.gain === 0));

  const chart = renderEqSummaryBar(bassSlider);
  assert.ok(chart.includes("Bass"));
  assert.ok(chart.includes("Mids"));
  assert.ok(chart.includes("Treble"));
});

test("applyEqToPlayer, applyFilterPreset, and speed/pitch send single atomic PATCH with instant buffer flush", async () => {
  const patches = [];
  const data = new Map();
  const fakePlayer = {
    guildId: "g1",
    playing: true,
    position: 42_500,
    queue: { current: { info: { isStream: false, isSeekable: true, duration: 200_000 } } },
    setData: (k, v) => data.set(k, v),
    getData: (k) => data.get(k),
    filterManager: { equalizerBands: [] },
    node: {
      info: { filters: ["equalizer", "timescale", "rotation", "lowPass", "karaoke", "vibrato", "tremolo"] },
      updatePlayer: async (req) => patches.push(req),
    },
  };

  // Single atomic PATCH for Bass Boost + immediate position flush
  await applyEqToPlayer(fakePlayer, getEqPresetBands("bassboost"), "Bass Boost");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].playerOptions.position, 42_500);
  assert.equal(patches[0].playerOptions.filters.equalizer.length, 15);
  assert.equal(data.get("activeEqLabel"), "Bass Boost");

  // Speed adjustment preserves active EQ in ONE single PATCH
  await applySpeedPitchToPlayer(fakePlayer, { speed: 1.25 });
  assert.equal(patches.length, 2);
  assert.equal(patches[1].playerOptions.filters.timescale.speed, 1.25);
  assert.equal(patches[1].playerOptions.filters.equalizer.length, 15);

  // Lo-Fi filter combines lowPass + equalizer in ONE single PATCH (not 3 sequential calls!)
  const before = patches.length;
  await applyFilterPreset(fakePlayer, "lofi");
  assert.equal(patches.length, before + 1);
  assert.ok(patches.at(-1).playerOptions.filters.lowPass);
  assert.equal(patches.at(-1).playerOptions.filters.equalizer.length, 15);

  // Live streams omit `position` so radio streams never break
  fakePlayer.queue.current.info.isStream = true;
  await applyFilterPreset(fakePlayer, "8d");
  assert.equal(patches.at(-1).playerOptions.position, undefined);

  // Reset sends empty filters object in ONE call
  await resetAllFilters(fakePlayer);
  assert.deepEqual(patches.at(-1).playerOptions.filters, {});

  assert.equal(resolveFilterPresetKey("slowed"), "daycore");
  for (const key of Object.keys(FILTER_PRESETS)) {
    const msg = await applyFilterPreset(fakePlayer, key);
    assert.equal(typeof msg, "string");
  }
});

test("parseThemeColor accepts named colors, default, and 6-digit hex codes", () => {
  assert.deepEqual(parseThemeColor("frog"), { ok: true, color: 0x4caf50, label: "frog" });
  assert.deepEqual(parseThemeColor("default"), { ok: true, color: null, label: "default" });
  assert.deepEqual(parseThemeColor("#1db954"), { ok: true, color: 0x1db954, label: "#1DB954" });
  assert.deepEqual(parseThemeColor("ff00aa"), { ok: true, color: 0xff00aa, label: "#FF00AA" });
  assert.equal(parseThemeColor("notacolor").ok, false);
});
