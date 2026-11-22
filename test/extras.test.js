import assert from "node:assert/strict";
import test from "node:test";
import { createAutoplayHandler } from "../src/services/autoplay.js";
import { GuildSettingsStore } from "../src/services/guildSettings.js";
import { chunkLyrics, cleanArtistName, cleanTrackTitle, fetchLyrics } from "../src/services/lyrics.js";
import { formatServerCountStatus, formatVoiceStatusText } from "../src/services/voiceStatus.js";
import {
  _setCustomEmojisForTest,
  getButtonEmoji,
  getTextEmoji,
} from "../src/ui/emojis.js";

const EMOJI_RE = /\p{Extended_Pictographic}/u;

test("formatServerCountStatus shows server count with zero emojis", () => {
  const single = formatServerCountStatus(1, "d!");
  const multi = formatServerCountStatus(12, "d!");
  assert.equal(single, "1 server | d!help");
  assert.equal(multi, "12 servers | d!help");
  assert.equal(EMOJI_RE.test(single), false);
  assert.equal(EMOJI_RE.test(multi), false);
});

test("formatVoiceStatusText formats clean emoji-free text with length cap", () => {
  const text = formatVoiceStatusText("Blinding Lights", "The Weeknd");
  assert.equal(text, "Now playing: Blinding Lights - The Weeknd");
  assert.equal(EMOJI_RE.test(text), false);

  const longText = formatVoiceStatusText("A".repeat(200), "Artist");
  assert.ok(longText.length <= 120);
  assert.ok(longText.endsWith("..."));
});

test("App Emojis override defaults for both static and animated icons", () => {
  _setCustomEmojisForTest([]);
  assert.equal(getTextEmoji("spotify"), "🟢");
  assert.equal(getButtonEmoji("play"), "▶️");

  _setCustomEmojisForTest([
    { id: "111222333", name: "spotify", animated: false },
    { id: "444555666", name: "playing", animated: true },
    { id: "777888999", name: "play", animated: false },
  ]);

  assert.equal(getTextEmoji("spotify"), "<:spotify:111222333>");
  assert.equal(getTextEmoji("playing"), "<a:playing:444555666>");
  assert.deepEqual(getButtonEmoji("play"), { id: "777888999", name: "play", animated: false });
  assert.equal(getButtonEmoji("stop"), "⏹️"); // Uncustomized fallback remains intact

  _setCustomEmojisForTest([]);
});

test("lyrics helpers clean YouTube titles and split long lyrics cleanly", async () => {
  assert.equal(cleanTrackTitle("Daft Punk - Get Lucky (Official Audio) ft. Pharrell"), "Daft Punk - Get Lucky");
  assert.equal(cleanArtistName("The Weeknd - Topic"), "The Weeknd");

  const chunks = chunkLyrics("line1\nline2\nline3\nline4", 12);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "line1\nline2");
  assert.equal(chunks[1], "line3\nline4");

  const result = await fetchLyrics({
    title: "Blinding Lights (Official Video)",
    author: "The Weeknd - Topic",
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        {
          trackName: "Blinding Lights",
          artistName: "The Weeknd",
          albumName: "After Hours",
          plainLyrics: "Yeah, I've been tryna call...",
        },
      ],
    }),
  });

  assert.equal(result.title, "Blinding Lights");
  assert.equal(result.artist, "The Weeknd");
  assert.equal(result.lyrics, "Yeah, I've been tryna call...");
});

test("autoplay handler skips duplicates and respects per-guild toggle", async () => {
  const guildSettings = new GuildSettingsStore();
  const handler = createAutoplayHandler({
    config: { defaultSearchPlatform: "ytmsearch" },
    guildSettings,
  });

  const added = [];
  const fakePlayer = {
    guildId: "g1",
    node: { info: { sourceManagers: ["youtube"] } },
    queue: {
      previous: [{ info: { identifier: "already1111", title: "Old Song" } }],
      add: async (t) => added.push(t),
    },
    search: async () => ({
      tracks: [
        { info: { identifier: "already1111", title: "Old Song", duration: 180_000, isStream: false } },
        { info: { identifier: "fresh222222", title: "Fresh Song", duration: 200_000, isStream: false } },
      ],
    }),
  };

  const lastTrack = {
    info: { identifier: "dQw4w9WgXcQ", title: "Last Song", author: "Artist", sourceName: "youtube" },
  };

  // Off by default -> should not add anything
  await handler(fakePlayer, lastTrack);
  assert.equal(added.length, 0);

  // Turn autoplay ON -> picks fresh track, skips already-played duplicate
  guildSettings.setAutoplay("g1", true);
  await handler(fakePlayer, lastTrack);
  assert.equal(added.length, 1);
  assert.equal(added[0].info.identifier, "fresh222222");
});
