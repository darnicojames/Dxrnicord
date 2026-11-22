/**
 * Smooth Start Pre-Buffering for Lavalink v4 / NodeLink v3.
 *
 * Starting a track with `paused: true` lets Lavaplayer open the upstream CDN stream
 * and pre-fill its internal AudioFrameBuffer in silence (~450ms on Lavalink, ~200ms on NodeLink)
 * before unpausing, eliminating choppy/stuttering first 1-2 seconds of songs.
 * Uses a monotonic nonce so track errors or rapid skips never trigger stale resume() calls.
 */

const DEFAULT_LAVALINK_PREBUFFER_MS = 450;
const DEFAULT_NODELINK_PREBUFFER_MS = 200;

/**
 * Invalidate any in-flight smoothPlay pre-buffer timer (called on trackError / trackStuck / stop).
 * @param {any} player
 */
export function cancelPendingPrebuffer(player) {
  if (!player) return;
  const nextNonce = (Number(player.getData("_smoothPlayNonce")) || 0) + 1;
  player.setData("_smoothPlayNonce", nextNonce);
  player.deleteData("_prebuffering");
  player.deleteData("_userPausedDuringPrebuffer");
}

/**
 * Play the next (or specified) track with quiet pre-buffering on seekable/non-stream tracks.
 *
 * @param {any} player
 * @param {Record<string, any>} [playOptions]
 * @param {{ prebufferMs?: number }} [opts]
 */
export async function smoothPlay(player, playOptions = {}, { prebufferMs } = {}) {
  if (!player) return;

  const defaultMs =
    player.node?.nodeType === "NodeLink"
      ? DEFAULT_NODELINK_PREBUFFER_MS
      : DEFAULT_LAVALINK_PREBUFFER_MS;
  const waitMs = prebufferMs ?? defaultMs;

  const targetTrack = playOptions.clientTrack || player.queue?.tracks?.[0] || player.queue?.current;
  const isLiveStream = Boolean(targetTrack?.info?.isStream);

  const nonce = (Number(player.getData("_smoothPlayNonce")) || 0) + 1;
  player.setData("_smoothPlayNonce", nonce);

  // Live radio streams should start directly without pause/resume
  if (isLiveStream || waitMs <= 0) {
    player.deleteData("_prebuffering");
    await player.play(playOptions);
    return;
  }

  player.setData("_prebuffering", true);
  player.deleteData("_userPausedDuringPrebuffer");

  try {
    await player.play({ ...playOptions, paused: true });
    await new Promise((resolve) => {
      const t = setTimeout(resolve, waitMs);
      t.unref?.();
    });

    // Only unpause if this exact smoothPlay call is still active and user didn't pause/skip/error
    if (
      player.getData("_smoothPlayNonce") === nonce &&
      player.connected &&
      player.paused &&
      !player.getData("_userPausedDuringPrebuffer") &&
      !player.getData("internal_destroystatus")
    ) {
      await player.resume();
    }
  } finally {
    if (player.getData("_smoothPlayNonce") === nonce) {
      player.deleteData("_prebuffering");
      player.deleteData("_userPausedDuringPrebuffer");
    }
  }
}
