import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNowPlayingEmbed,
  buildPlayerControls,
  buildProgressBar,
  buildQueueEmbed,
  escapeMarkdownLinkText,
  formatDuration,
  parseTimeToMs,
} from "../src/ui/embeds.js";

test("formatDuration formats seconds, minutes, hours, and streams", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65_000), "1:05");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.equal(formatDuration(999_999, true), "LIVE");
});

test("parseTimeToMs parses numeric seconds, mm:ss, and hh:mm:ss", () => {
  assert.equal(parseTimeToMs("90"), 90_000);
  assert.equal(parseTimeToMs("1:30"), 90_000);
  assert.equal(parseTimeToMs("1:02:03"), 3_723_000);
  assert.equal(parseTimeToMs("1:75"), null);
  assert.equal(parseTimeToMs("abc"), null);
  assert.equal(parseTimeToMs(""), null);
});

test("escapeMarkdownLinkText prevents bracket injection", () => {
  assert.equal(escapeMarkdownLinkText("Song [Official Video]"), "Song (Official Video)");
});

test("progress bar and embed builders produce valid Discord structures", () => {
  const bar = buildProgressBar(60_000, 120_000, 10);
  assert.ok(bar.includes("1:00"));
  assert.ok(bar.includes("2:00"));
  assert.ok(bar.includes("🔘"));

  const fakeTrack = {
    info: {
      title: "Midnight City",
      author: "M83",
      duration: 243_000,
      uri: "https://open.spotify.com/track/123",
      artworkUrl: "https://example.com/art.jpg",
      sourceName: "spotify",
      isStream: false,
    },
    requester: { id: "123456789", username: "tester" },
    pluginInfo: {},
  };

  const fakePlayer = {
    paused: false,
    repeatMode: "off",
    volume: 80,
    position: 45_000,
    queue: { current: fakeTrack, tracks: [fakeTrack] },
  };

  const np = buildNowPlayingEmbed(fakePlayer, fakeTrack, { showProgress: true }).toJSON();
  assert.equal(np.author.name, "Now Playing");
  assert.ok(np.description.includes("Midnight City"));

  const controls = buildPlayerControls(fakePlayer).toJSON();
  assert.equal(controls.components.length, 5);

  const q = buildQueueEmbed(fakePlayer, 1).toJSON();
  assert.equal(q.title, "Music Queue");
});
