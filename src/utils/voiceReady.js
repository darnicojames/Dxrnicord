/**
 * Tracks real Discord Voice Gateway + Lavalink DAVE E2EE handshake readiness per guild.
 *
 * `player.connect()` resolves immediately after sending OP 4, BEFORE Discord returns
 * VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE and BEFORE Lavalink establishes its UDP +
 * DAVE MLS encrypted voice tunnel. Waiting for that handshake (in parallel with track
 * resolution!) eliminates intro stuttering and clipped first seconds.
 */

const DEFAULT_VOICE_TIMEOUT_MS = 2500;
const DAVE_SETTLE_MS = 400;

export class VoiceReadinessTracker {
  /**
   * @param {{ settleMs?: number, timeoutMs?: number }} [opts]
   */
  constructor({ settleMs = DAVE_SETTLE_MS, timeoutMs = DEFAULT_VOICE_TIMEOUT_MS } = {}) {
    this.settleMs = settleMs;
    this.timeoutMs = timeoutMs;
    /** @type {Set<string>} */
    this.readyGuilds = new Set();
    /** @type {Map<string, Set<() => void>>} */
    this.waiters = new Map();
  }

  /**
   * Mark a guild's voice connection as relayed to Lavalink (called after VOICE_SERVER_UPDATE completes).
   * @param {string} guildId
   */
  markVoiceRelayed(guildId) {
    if (!guildId) return;
    this.readyGuilds.add(guildId);
    const pending = this.waiters.get(guildId);
    if (pending) {
      this.waiters.delete(guildId);
      for (const resolve of pending) resolve();
    }
  }

  /**
   * Reset readiness when a player disconnects or is destroyed.
   * @param {string} guildId
   */
  clear(guildId) {
    if (!guildId) return;
    this.readyGuilds.delete(guildId);
  }

  isReady(guildId) {
    return this.readyGuilds.has(guildId);
  }

  /**
   * Connect the player (if not already connected) and wait until Lavalink has received
   * VOICE_SERVER_UPDATE + a brief settle window for UDP & DAVE MLS encryption to stabilize.
   * Safe to run in parallel with `resolveQuery()`!
   *
   * @param {any} player
   */
  async connectAndWaitReady(player) {
    if (!player) return;
    const guildId = player.guildId;

    // Already connected and handshake previously completed -> zero delay!
    if (player.connected && this.readyGuilds.has(guildId)) {
      return;
    }

    const waitForRelay = new Promise((resolve) => {
      if (this.readyGuilds.has(guildId)) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        const set = this.waiters.get(guildId);
        if (set) {
          set.delete(done);
          if (set.size === 0) this.waiters.delete(guildId);
        }
        resolve();
      };

      const timer = setTimeout(done, this.timeoutMs);
      timer.unref?.();

      if (!this.waiters.has(guildId)) this.waiters.set(guildId, new Set());
      this.waiters.get(guildId).add(done);
    });

    if (!player.connected) {
      await player.connect();
    }

    await waitForRelay;

    // Brief settle window so Lavalink's UDP + DAVE MLS key exchange finishes before frame 0
    if (this.settleMs > 0) {
      await new Promise((r) => setTimeout(r, this.settleMs));
    }
  }
}
