import assert from "node:assert/strict";
import test from "node:test";
import { formatFriendlyTrackError, isTrackNearEnd } from "../src/events/lavalinkEvents.js";
import { stripParentheticals } from "../src/services/lyrics.js";
import {
  isNodeYoutubeBlocked,
  isYoutubeBotBlockError,
  markNodeYoutubeBlocked,
} from "../src/services/nodeDiscovery.js";
import { cancelPendingPrebuffer, smoothPlay } from "../src/utils/smoothPlay.js";

test("smoothPlay pre-buffers paused tracks and resumes automatically, skipping live streams", async () => {
  const events = [];
  const data = new Map();
  const fakePlayer = {
    connected: true,
    paused: false,
    queue: { tracks: [{ info: { isStream: false } }], current: null },
    getData: (k) => data.get(k),
    setData: (k, v) => data.set(k, v),
    deleteData: (k) => data.delete(k),
    play: async (opts) => {
      events.push(`play:paused=${Boolean(opts?.paused)}`);
      fakePlayer.paused = Boolean(opts?.paused);
    },
    resume: async () => {
      events.push("resume");
      fakePlayer.paused = false;
    },
  };

  await smoothPlay(fakePlayer, {}, { prebufferMs: 15 });
  assert.deepEqual(events, ["play:paused=true", "resume"]);
  assert.equal(data.get("_prebuffering"), undefined);

  // Live stream skips prebuffer pause/resume
  events.length = 0;
  fakePlayer.queue.tracks = [{ info: { isStream: true } }];
  await smoothPlay(fakePlayer, {}, { prebufferMs: 15 });
  assert.deepEqual(events, ["play:paused=false"]);
});

test("YouTube bot-block detection, node flagging, and friendly error formatting strip Java stack traces", () => {
  const rawTrace =
    "(yts.version: f45bbb7) All clients failed to load the item.\n" +
    "Client [MWEB] failed: This video requires login.\n" +
    "at dev.lavalink.youtube.clients.skeleton.Client.getPlayabilityStatus(Client.java:94)\n" +
    "Client [TVHTML5_SIMPLY] failed: Sign in to confirm you’re not a bot";

  assert.equal(isYoutubeBotBlockError(rawTrace), true);

  markNodeYoutubeBlocked("node-yt-blocked");
  assert.equal(isNodeYoutubeBlocked("node-yt-blocked"), true);
  assert.equal(isNodeYoutubeBlocked("node-healthy"), false);

  const friendly = formatFriendlyTrackError(rawTrace);
  assert.equal(friendly.includes("dev.lavalink"), false);
  assert.equal(friendly.includes("\n"), false);
  assert.ok(friendly.toLowerCase().includes("youtube"));

  assert.equal(
    stripParentheticals("What if I miss you for the rest of my life? (Live in the Studio)"),
    "What if I miss you for the rest of my life?",
  );
});

test("isTrackNearEnd prevents EOF stalls from restarting songs back at 0:00", () => {
  assert.equal(isTrackNearEnd(5_000, 180_000), false);
  assert.equal(isTrackNearEnd(90_000, 180_000), false);
  assert.equal(isTrackNearEnd(170_000, 180_000), true); // within last 12s
  assert.equal(isTrackNearEnd(225_000, 250_000), true); // 90% finished
});

test("cancelPendingPrebuffer prevents stale resume() calls if a track errors during pre-buffering", async () => {
  const events = [];
  const data = new Map();
  const fakePlayer = {
    connected: true,
    paused: false,
    queue: { tracks: [{ info: { isStream: false } }], current: null },
    getData: (k) => data.get(k),
    setData: (k, v) => data.set(k, v),
    deleteData: (k) => data.delete(k),
    play: async (opts) => {
      events.push(`play:paused=${Boolean(opts?.paused)}`);
      fakePlayer.paused = Boolean(opts?.paused);
      // Simulate immediate TrackExceptionEvent cancelling prebuffer during the wait
      cancelPendingPrebuffer(fakePlayer);
    },
    resume: async () => {
      events.push("stale-resume");
    },
  };

  await smoothPlay(fakePlayer, {}, { prebufferMs: 20 });
  assert.deepEqual(events, ["play:paused=true"]);
});
