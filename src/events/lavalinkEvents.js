import { Events } from "discord.js";
import {
  getNodeFailedSources,
  getNodePenalty,
  isYoutubeBotBlockError,
  markNodeSourceFailed,
  normalizeSourceName,
  pickFastestConnectedNode,
  recordNodeIssue,
} from "../services/nodeDiscovery.js";
import { tuneRadioStream } from "../services/radio.js";
import { resolveAlternateMirror } from "../services/trackResolver.js";
import { resetSkipVotes } from "../services/voteSkip.js";
import {
  clearVoiceChannelStatus,
  formatVoiceStatusText,
  setVoiceChannelStatus,
} from "../services/voiceStatus.js";
import {
  buildNowPlayingEmbed,
  buildPlayerControls,
  buildStatusEmbed,
  getTrackDisplay,
} from "../ui/embeds.js";
import { cancelPendingPrebuffer, smoothPlay } from "../utils/smoothPlay.js";

const MAX_RADIO_CONSECUTIVE_RETRIES = 5;
const MAX_TRACK_RECOVERY_ATTEMPTS = 2;

/**
 * Convert noisy Lavalink Java stack traces into a clean 1-line Discord message.
 * @param {string} rawMessage
 */
export function formatFriendlyTrackError(rawMessage) {
  const raw = String(rawMessage || "Playback failed on audio server").trim();
  if (isYoutubeBotBlockError(raw)) {
    return "YouTube blocked this public audio server (bot/login check), and no alternate mirror matched.";
  }
  // Strip multi-line Java stack traces (`at dev.lavalink...`)
  const firstLine = raw.split(/\r?\n/)[0].replace(/\s+at\s+[\w.$]+\(.*/i, "").trim();
  if (!firstLine) return "Playback failed on audio server.";
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

/**
 * Safely strip buttons from a previously sent Now Playing message.
 */
async function clearPreviousControls(player) {
  const prevMsg = player.getData("nowPlayingMessage");
  if (!prevMsg) return;
  player.deleteData("nowPlayingMessage");
  await prevMsg.edit({ components: [] }).catch(() => {});
}

/**
 * Safely fetch a player's text channel and send a payload.
 */
async function sendToPlayerChannel(client, player, payload) {
  if (!player?.textChannelId) return null;
  const channel =
    client.channels.cache.get(player.textChannelId) ||
    (await client.channels.fetch(player.textChannelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return null;
  return channel.send(payload).catch(() => null);
}

/**
 * Determine whether a track was already near the end when a stall/error fired
 * (e.g. Lavaplayer EOF stall in the final seconds) so we finish cleanly instead of restarting!
 */
export function isTrackNearEnd(positionMs, durationMs) {
  const pos = Math.max(0, Number(positionMs) || 0);
  const dur = Number(durationMs) || 0;
  if (dur <= 0) return false;
  return dur - pos <= 12_000 || pos / dur >= 0.88;
}

/**
 * Safely migrate a player to a healthier node without replaying a broken track
 * and without strict source-name rejections between Lavalink and NodeLink.
 */
async function migratePlayerNode(player, targetNode, { clearBrokenCurrent = false } = {}) {
  if (!player || !targetNode) return false;
  const targetId = typeof targetNode === "string" ? targetNode : targetNode.options?.id;
  if (!targetId || targetId === player.node?.options?.id) return false;

  const savedCurrent = player.queue?.current;
  if (clearBrokenCurrent && player.queue) {
    player.queue.current = null;
  }

  try {
    if (typeof player.changeNode === "function") {
      await player.changeNode(targetNode, false);
    } else {
      await player.moveNode(targetId);
    }
    return true;
  } catch {
    if (clearBrokenCurrent && player.queue && !player.queue.current && savedCurrent) {
      player.queue.current = savedCurrent;
    }
    return false;
  }
}

/**
 * Automatically retry a stalled/errored track (up to 2 attempts across alternate sources & healthier nodes).
 * - Never restarts a song that already reached the end (last 12s / 88%+).
 * - Resumes at the exact `resumePosition` if stalled mid-song (NEVER loops back to 0:00!).
 * - Migrates automatically to a healthier node when the current node is failing or already failed once.
 * - Preserves queued tracks if lavalink-client's `TrackEndEvent(loadFailed)` popped the next song during lookup.
 */
async function tryRecoverTrack(client, player, failedTrack, { isStuck = false } = {}) {
  if (!player || !failedTrack) return null;
  const clientData = failedTrack.pluginInfo?.clientData || {};
  const prevAttempts = Number(clientData._recoveryAttempts || (clientData._retriedFallback ? 1 : 0));
  if (prevAttempts >= MAX_TRACK_RECOVERY_ATTEMPTS) return null;
  if (player.getData("_recoveringTrack")) return null;

  const resumePosition = Math.max(0, Math.floor(player.position || 0));
  const duration = Number(failedTrack?.info?.duration || 0);

  // If the song was basically finished when Lavalink stalled at EOF, let it finish & advance cleanly!
  if (isTrackNearEnd(resumePosition, duration)) {
    return null;
  }

  // On `trackStuck`, lavalink-client immediately advances the queue if more tracks are waiting;
  // do NOT overwrite the next track by replaying an old mid-song stall from scratch!
  if (isStuck && resumePosition >= 15_000 && player.queue.tracks.length > 0) {
    return null;
  }

  const currentNodeId = player.node?.options?.id;
  const triedNodeIds = new Set(Array.isArray(clientData._triedNodeIds) ? clientData._triedNodeIds : []);
  if (currentNodeId) triedNodeIds.add(currentNodeId);

  // Snapshot the next queued track BEFORE async lookup so we can restore it if TrackEnd(loadFailed) pops it
  const nextQueuedBefore = player.queue?.tracks?.[0] || null;
  const nextQueuedEncoded = nextQueuedBefore?.encoded || null;

  player.setData("_recoveringTrack", true);
  try {
    let mirror = null;
    let migratedTo = null;

    const healthierOther = client
      ? pickFastestConnectedNode(client, { excludeNodeIds: triedNodeIds })
      : null;
    const currentNodeUnhealthy =
      getNodePenalty(currentNodeId) >= 700 || getNodeFailedSources(currentNodeId).size >= 2;
    const shouldMigrateFirst = Boolean(healthierOther && (prevAttempts >= 1 || currentNodeUnhealthy));

    if (shouldMigrateFirst) {
      const moved = await migratePlayerNode(player, healthierOther, { clearBrokenCurrent: true });
      if (moved) {
        migratedTo = healthierOther.options.id;
        triedNodeIds.add(migratedTo);
        mirror = await resolveAlternateMirror(player, failedTrack, failedTrack.requester, {
          allowSameSource: true,
        });
      }
    }

    // If we didn't migrate first (or migrated node had no match), try alternate source on current node
    if (!mirror && !migratedTo) {
      mirror = await resolveAlternateMirror(player, failedTrack, failedTrack.requester, {
        allowSameSource: false,
      });
    }

    // Fallback: migrate to a healthier connected node if current node couldn't produce a working mirror
    if (!mirror && healthierOther && !migratedTo) {
      const moved = await migratePlayerNode(player, healthierOther, { clearBrokenCurrent: true });
      if (moved) {
        migratedTo = healthierOther.options.id;
        triedNodeIds.add(migratedTo);
        mirror = await resolveAlternateMirror(player, failedTrack, failedTrack.requester, {
          allowSameSource: true,
        });
      }
    }

    if (!mirror) return null;

    const mirrorDuration = Number(mirror?.info?.duration || 0);
    let targetPosition = 0;

    if (resumePosition >= 15_000) {
      // Mid-song recovery MUST resume at the exact timestamp — never loop back to 0:00!
      if (!mirror.info?.isSeekable || (mirrorDuration > 0 && resumePosition >= mirrorDuration - 5000)) {
        return null;
      }
      targetPosition = resumePosition;
    }

    mirror.pluginInfo = {
      ...(mirror.pluginInfo || {}),
      clientData: {
        ...(mirror.pluginInfo?.clientData || {}),
        _retriedFallback: true,
        _recoveryAttempts: prevAttempts + 1,
        _triedNodeIds: [...triedNodeIds],
      },
    };

    // If TrackEndEvent(loadFailed) popped the next queued song into `queue.current` while we were resolving,
    // push it right back to the front of `queue.tracks` so it still plays after this recovered song!
    if (
      nextQueuedEncoded &&
      player.queue?.current?.encoded === nextQueuedEncoded &&
      player.queue.tracks[0]?.encoded !== nextQueuedEncoded
    ) {
      player.queue.tracks.unshift(player.queue.current);
    }

    const playOpts = { clientTrack: mirror, noReplace: false };
    if (targetPosition > 0) {
      playOpts.position = targetPosition;
    }

    await smoothPlay(player, playOpts);
    return {
      ok: true,
      migratedTo,
      sourceName: mirror.info?.sourceName || "alternate",
    };
  } catch {
    return null;
  } finally {
    player.deleteData("_recoveringTrack");
  }
}

/**
 * Register Lavalink player, node, voice-channel status, 24/7 radio watchdog,
 * self-healing recovery, and auto-leave listeners.
 */
export function registerLavalinkEvents(client, config, guildSettings, voiceTracker = null) {
  const emptyVoiceTimers = new Map();
  const idleQueueTimers = new Map();
  const radioRetryTimers = new Map();
  const radioStableTimers = new Map();

  const clearTimer = (map, guildId) => {
    const existing = map.get(guildId);
    if (existing) {
      clearTimeout(existing);
      map.delete(guildId);
    }
  };

  /**
   * Schedule automatic stream re-tune when a 24/7 radio stream drops unexpectedly.
   */
  const scheduleRadioReconnect = (player) => {
    const guildId = player.guildId;
    const station = guildSettings.getRadioStation(guildId);
    if (!station) return false;
    if (radioRetryTimers.has(guildId)) return true;

    const attempts = Number(player.getData("_radioRetryCount") || 0) + 1;
    if (attempts > MAX_RADIO_CONSECUTIVE_RETRIES) {
      console.error(
        `[Radio ${guildId}] "${station.name}" failed ${MAX_RADIO_CONSECUTIVE_RETRIES} consecutive reconnects; stopping radio watchdog.`,
      );
      guildSettings.setRadioStation(guildId, null);
      sendToPlayerChannel(client, player, {
        embeds: [
          buildStatusEmbed(
            `24/7 radio **${station.name}** could not reconnect after ${MAX_RADIO_CONSECUTIVE_RETRIES} retries. Use \`${config.prefix}radio\` to pick another station.`,
            "warning",
          ),
        ],
      }).catch(() => {});
      return false;
    }

    player.setData("_radioRetryCount", attempts);
    const delayMs = Math.min(30_000, attempts * 4000);
    console.warn(
      `[Radio ${guildId}] Stream dropped for "${station.name}". Auto-reconnecting in ${delayMs / 1000}s (attempt ${attempts}/${MAX_RADIO_CONSECUTIVE_RETRIES})...`,
    );

    const timer = setTimeout(async () => {
      radioRetryTimers.delete(guildId);
      const activeStation = guildSettings.getRadioStation(guildId);
      const activePlayer = client.lavalink.getPlayer(guildId);
      if (!activeStation || !activePlayer) return;

      const res = await tuneRadioStream(activePlayer, activeStation, {
        id: null,
        username: "24/7 Radio",
      });
      if (!res.ok) {
        scheduleRadioReconnect(activePlayer);
      }
    }, delayMs);

    timer.unref?.();
    radioRetryTimers.set(guildId, timer);
    return true;
  };

  // --- Node Manager Events ---
  client.lavalink.nodeManager.on("connect", (node) => {
    const ver = node.info?.version?.semver || "v4";
    console.log(`[Lavalink] Node "${node.options.id}" connected (${node.nodeType} ${ver}).`);
    // Enable Lavalink v4 Session Resuming (60s) so brief network blips don't drop active VC playback
    if (typeof node.updateSession === "function" && node.sessionId) {
      node.updateSession(true, 60).catch(() => {});
    }
  });

  client.lavalink.nodeManager.on("raw", (node, payload) => {
    if (payload?.op === "ready" && payload?.sessionId && typeof node?.updateSession === "function") {
      node.updateSession(true, 60).catch(() => {});
    }
  });

  client.lavalink.nodeManager.on("reconnecting", (node) => {
    console.warn(`[Lavalink] Node "${node.options.id}" reconnecting...`);
  });

  client.lavalink.nodeManager.on("disconnect", (node, reason) => {
    if (reason?.code !== 1000) {
      recordNodeIssue(node.options?.id);
    }
    console.warn(
      `[Lavalink] Node "${node.options.id}" disconnected (code=${reason?.code ?? "?"}, reason=${reason?.reason || "none"}).`,
    );
  });

  client.lavalink.nodeManager.on("error", (node, error) => {
    console.error(`[Lavalink] Node "${node.options.id}" error: ${error?.message || error}`);
  });

  // --- Player Events ---
  client.lavalink.on("trackStart", async (player, track) => {
    if (!track) return;
    resetSkipVotes(player);
    clearTimer(idleQueueTimers, player.guildId);
    clearTimer(radioRetryTimers, player.guildId);

    const prefs = guildSettings.get(player.guildId);
    const info = getTrackDisplay(track);
    const isRadio = Boolean(track.pluginInfo?.clientData?.isRadio);

    // Reset radio retry counter once stream plays stably for 15 seconds
    if (isRadio) {
      clearTimer(radioStableTimers, player.guildId);
      const stableTimer = setTimeout(() => {
        radioStableTimers.delete(player.guildId);
        player.deleteData("_radioRetryCount");
      }, 15_000);
      stableTimer.unref?.();
      radioStableTimers.set(player.guildId, stableTimer);
    }

    // Fire-and-forget voice channel status (clean plain text, no emojis)
    const vcStatus = isRadio
      ? `Radio 24/7: ${info.title}`.slice(0, 120)
      : formatVoiceStatusText(info.title, info.author);
    setVoiceChannelStatus(client, player.voiceChannelId, vcStatus).catch(() => {});

    // Avoid spamming repeated Now Playing cards on silent 24/7 radio auto-reconnects
    if (isRadio && Number(player.getData("_radioRetryCount") || 0) > 0) {
      return;
    }

    const isPrebuffering = Boolean(player.getData("_prebuffering"));
    const isRecovered = Boolean(track.pluginInfo?.clientData?._retriedFallback);
    const nowPlayingPayload = {
      embeds: [
        buildNowPlayingEmbed(player, track, {
          autoplay: prefs.autoplay,
          stay247: prefs.stay247,
          themeColor: prefs.themeColor,
          pausedOverride: isPrebuffering ? false : undefined,
        }),
      ],
      components: [buildPlayerControls(player, { pausedOverride: isPrebuffering ? false : undefined })],
    };

    // On instant track recovery, edit the existing Now Playing card in place instead of posting a duplicate!
    const existingMsg = player.getData("nowPlayingMessage");
    if (isRecovered && existingMsg && typeof existingMsg.edit === "function") {
      const edited = await existingMsg.edit(nowPlayingPayload).catch(() => null);
      if (edited) {
        player.setData("nowPlayingMessage", edited);
        return;
      }
    }

    clearPreviousControls(player).catch(() => {});
    const msg = await sendToPlayerChannel(client, player, nowPlayingPayload);

    if (msg) {
      player.setData("nowPlayingMessage", msg);
    }
  });

  client.lavalink.on("trackError", async (player, track, payload) => {
    cancelPendingPrebuffer(player);
    const nodeId = player.node?.options?.id;
    recordNodeIssue(nodeId);

    const rawMessage = payload?.exception?.message || "";
    const rawCause = payload?.exception?.cause || "";
    const rawTrace = payload?.exception?.causeStackTrace || "";
    const fullDiag = [rawMessage, rawCause, rawTrace].filter(Boolean).join("\n");
    const rawReason = rawMessage || rawCause || "Playback failed on audio server";

    // Severe server hang/timeout (e.g. NodeLink `playerStateChange timed out after 15000ms`):
    // record a second penalty strike immediately so tryRecoverTrack migrates off this slow node!
    if (/timed out|playerStateChange|ETIMEDOUT|ECONNRESET|socket hang up/i.test(fullDiag)) {
      recordNodeIssue(nodeId);
    }

    const failedSource = normalizeSourceName(track?.info?.sourceName);
    if (failedSource) {
      markNodeSourceFailed(nodeId, failedSource);
    }
    if (isYoutubeBotBlockError(fullDiag)) {
      markNodeSourceFailed(nodeId, "youtube");
    }

    if (guildSettings.getRadioStation(player.guildId)) {
      scheduleRadioReconnect(player);
      return;
    }

    if (isTrackNearEnd(player.position, track?.info?.duration)) {
      return;
    }

    const title = track ? getTrackDisplay(track).title : "Track";
    const friendlyReason = formatFriendlyTrackError(isYoutubeBotBlockError(fullDiag) ? fullDiag : rawReason);
    const causeNote =
      rawCause && rawCause !== rawMessage
        ? ` (cause: ${String(rawCause).split(/\r?\n/)[0].slice(0, 120)})`
        : "";
    console.error(
      `[Player ${player.guildId}] Track error on "${nodeId || "?"}" [${failedSource || "?"}] for "${title}": ${friendlyReason}${causeNote}`,
    );

    const recovered = await tryRecoverTrack(client, player, track);
    if (recovered?.ok) {
      const dest = recovered.migratedTo
        ? `migrated to "${recovered.migratedTo}" (${recovered.sourceName})`
        : `switched to ${recovered.sourceName} mirror`;
      console.log(`[Player ${player.guildId}] Recovered "${title}" — ${dest}.`);
      return;
    }

    await sendToPlayerChannel(client, player, {
      embeds: [buildStatusEmbed(`⚠️ Skipped **${title}** — ${friendlyReason}`, "warning")],
    });
  });

  client.lavalink.on("trackStuck", async (player, track) => {
    cancelPendingPrebuffer(player);
    const nodeId = player.node?.options?.id;
    recordNodeIssue(nodeId);

    if (guildSettings.getRadioStation(player.guildId)) {
      scheduleRadioReconnect(player);
      return;
    }

    if (isTrackNearEnd(player.position, track?.info?.duration)) {
      return;
    }

    const title = track ? getTrackDisplay(track).title : "Track";
    console.warn(`[Player ${player.guildId}] Track stuck on "${nodeId || "?"}": "${title}" — attempting recovery...`);

    const recovered = await tryRecoverTrack(client, player, track, { isStuck: true });
    if (recovered?.ok) {
      const dest = recovered.migratedTo
        ? `migrated to "${recovered.migratedTo}" (${recovered.sourceName})`
        : `switched to ${recovered.sourceName} mirror`;
      console.log(`[Player ${player.guildId}] Recovered stalled track "${title}" — ${dest}.`);
      return;
    }

    await sendToPlayerChannel(client, player, {
      embeds: [buildStatusEmbed(`⚠️ **${title}** stalled on the audio server; moving on.`, "warning")],
    });
  });

  client.lavalink.on("queueEnd", async (player) => {
    if (player.getData("_recoveringTrack")) return;

    // 24/7 Radio Watchdog: if a radio stream ends unexpectedly, automatically re-tune!
    if (guildSettings.getRadioStation(player.guildId)) {
      scheduleRadioReconnect(player);
      return;
    }

    await clearPreviousControls(player);
    clearVoiceChannelStatus(client, player.voiceChannelId).catch(() => {});

    const stay247 = guildSettings.isStay247(player.guildId);
    if (stay247) {
      await sendToPlayerChannel(client, player, {
        embeds: [
          buildStatusEmbed(
            `Queue finished. Staying in voice channel (**24/7 mode ON**). Use \`${config.prefix}play\` or \`${config.prefix}radio\` to keep music going.`,
            "info",
          ),
        ],
      });
      return;
    }

    await sendToPlayerChannel(client, player, {
      embeds: [
        buildStatusEmbed(
          `Queue finished. Add more songs with \`${config.prefix}play\` or I'll leave in ${config.idleLeaveSeconds}s.`,
          "info",
        ),
      ],
    });

    clearTimer(idleQueueTimers, player.guildId);
    const timer = setTimeout(async () => {
      idleQueueTimers.delete(player.guildId);
      if (guildSettings.isStay247(player.guildId)) return;
      const activePlayer = client.lavalink.getPlayer(player.guildId);
      if (!activePlayer) return;
      if (activePlayer.playing || activePlayer.queue.tracks.length > 0) return;
      await activePlayer.destroy("idle-queue-timeout").catch(() => {});
    }, config.idleLeaveSeconds * 1000);

    timer.unref?.();
    idleQueueTimers.set(player.guildId, timer);
  });

  client.lavalink.on("playerSocketClosed", async (player, payload) => {
    const code = payload?.code;
    if (code === 4017) {
      const oldId = player.node?.options?.id;
      recordNodeIssue(oldId);
      console.error(
        `[Player ${player.guildId}] Discord closed voice websocket with 4017 (DAVE E2EE required) on node "${oldId}". Attempting failover...`,
      );
      const healthier = pickFastestConnectedNode(client, { excludeNodeIds: oldId ? [oldId] : [] });
      const moved = healthier ? await migratePlayerNode(player, healthier) : false;
      if (moved) return;

      await sendToPlayerChannel(client, player, {
        embeds: [
          buildStatusEmbed(
            `⚠️ Discord rejected voice encryption (Close Code \`4017\`: DAVE E2EE required). The active Lavalink node needs Lavalink v4.2.0+. Admins can check \`${config.prefix}nodes\`.`,
            "error",
          ),
        ],
      });
    }
  });

  client.lavalink.on("playerDisconnect", (player) => {
    cancelPendingPrebuffer(player);
    voiceTracker?.clear(player.guildId);
  });

  client.lavalink.on("playerDestroy", async (player) => {
    cancelPendingPrebuffer(player);
    resetSkipVotes(player);
    voiceTracker?.clear(player.guildId);
    clearTimer(emptyVoiceTimers, player.guildId);
    clearTimer(idleQueueTimers, player.guildId);
    clearTimer(radioRetryTimers, player.guildId);
    clearTimer(radioStableTimers, player.guildId);
    await clearPreviousControls(player);
    clearVoiceChannelStatus(client, player.voiceChannelId).catch(() => {});
  });

  // --- Auto-leave when everyone else leaves the voice channel (skipped when 24/7 mode is ON) ---
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = oldState.guild?.id || newState.guild?.id;
    if (!guildId) return;

    const player = client.lavalink.getPlayer(guildId);
    if (!player || !player.voiceChannelId) {
      clearTimer(emptyVoiceTimers, guildId);
      return;
    }

    if (guildSettings.isStay247(guildId) || guildSettings.getRadioStation(guildId)) {
      clearTimer(emptyVoiceTimers, guildId);
      return;
    }

    const channel = oldState.guild.channels.cache.get(player.voiceChannelId);
    if (!channel || !("members" in channel)) return;

    const humanCount = channel.members.filter((m) => !m.user.bot).size;

    if (humanCount === 0) {
      if (emptyVoiceTimers.has(guildId)) return;
      const timer = setTimeout(async () => {
        emptyVoiceTimers.delete(guildId);
        if (guildSettings.isStay247(guildId) || guildSettings.getRadioStation(guildId)) return;
        const activePlayer = client.lavalink.getPlayer(guildId);
        if (!activePlayer || !activePlayer.voiceChannelId) return;

        const freshChannel = oldState.guild.channels.cache.get(activePlayer.voiceChannelId);
        const stillEmpty = !freshChannel || freshChannel.members.filter((m) => !m.user.bot).size === 0;
        if (!stillEmpty) return;

        await sendToPlayerChannel(client, activePlayer, {
          embeds: [
            buildStatusEmbed(
              "Everyone left the voice channel, so I disconnected to save resources.",
              "info",
            ),
          ],
        });
        await activePlayer.destroy("voice-channel-empty").catch(() => {});
      }, config.idleLeaveSeconds * 1000);

      timer.unref?.();
      emptyVoiceTimers.set(guildId, timer);
    } else {
      clearTimer(emptyVoiceTimers, guildId);
    }
  });
}
