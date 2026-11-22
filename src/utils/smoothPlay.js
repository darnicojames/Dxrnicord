/**
 * Smooth Start Pre-Buffering for Lavalink v4 / NodeLink v3.
 *
 * - On NodeLink v3: plays immediately with `paused: false` (native streaming, no cold-start stutter).
 * - On Java Lavalink v4: starts with `paused: true` so Lavaplayer fills its internal
 *   AudioFrameBuffer in silence (~350ms), then sends an explicit REST `paused: false`
 *   directly via `player.node.updatePlayer(...)`.
 *
 * IMPORTANT: In `lavalink-client` v2, `player.play({ paused: true })` does NOT set `player.paused = true`,
 * and `TrackStartEvent` forces `player.paused = false` even while Lavalink is still paused!
 * Therefore we NEVER gate the unpause on `player.paused` and NEVER rely on `player.resume()`.
 */

const DEFAULT_LAVALINK_PREBUFFER_MS = 250;

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
 * Play the next (or specified) track smoothly without ever leaving Lavalink stuck paused.
 *
 * @param {any} player
 * @param {Record<string, any>} [playOptions]
 * @param {{ prebufferMs?: number }} [opts]
 */
export async function smoothPlay(player, playOptions = {}, { prebufferMs } = {}) {
  if (!player) return;

  const isNodeLink = player.node?.nodeType === "NodeLink";
  const waitMs = prebufferMs ?? (isNodeLink ? 0 : DEFAULT_LAVALINK_PREBUFFER_MS);

  const targetTrack = playOptions.clientTrack || player.queue?.tracks?.[0] || player.queue?.current;
  const isLiveStream = Boolean(targetTrack?.info?.isStream);

  const nonce = (Number(player.getData("_smoothPlayNonce")) || 0) + 1;
  player.setData("_smoothPlayNonce", nonce);

  // NodeLink and live radio streams play directly with explicit `paused: false`
  if (isLiveStream || waitMs <= 0) {
    player.deleteData("_prebuffering");
    player.paused = false;
    await player.play({ ...playOptions, paused: false });
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

    // Unconditionally unpause on the server if this smoothPlay call is still active
    // and the user didn't explicitly pause, skip, stop, or hit a track error.
    if (
      player.getData("_smoothPlayNonce") === nonce &&
      player.connected &&
      !player.getData("_userPausedDuringPrebuffer") &&
      !player.getData("internal_destroystatus")
    ) {
      player.paused = false;
      if (typeof player.node?.updatePlayer === "function") {
        await player.node.updatePlayer({
          guildId: player.guildId,
          playerOptions: { paused: false },
        });
      } else if (typeof player.resume === "function") {
        await player.resume();
      }
    }
  } finally {
    if (player.getData("_smoothPlayNonce") === nonce) {
      player.deleteData("_prebuffering");
      player.deleteData("_userPausedDuringPrebuffer");
    }
  }
}
