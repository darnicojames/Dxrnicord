import { stripParentheticals } from "./lyrics.js";
import { getNodeSources, searchWithFallback } from "./trackResolver.js";

const MAX_AUTOPLAY_DURATION_MS = 15 * 60 * 1000; // Skip 3-hour compilations/livestreams
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function normalizeTrackTitle(track) {
  const raw = track?.pluginInfo?.clientData?.originTitle || track?.info?.title || "";
  return stripParentheticals(raw).toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Build a set of previously played track keys (identifier + normalized title) to avoid repeats.
 */
function buildPlayedHistorySet(player, lastTrack) {
  const seen = new Set();
  const add = (t) => {
    if (!t?.info) return;
    if (t.info.identifier) seen.add(`id:${t.info.identifier}`);
    if (t.info.isrc) seen.add(`isrc:${t.info.isrc}`);
    if (t.info.title) seen.add(`raw:${t.info.title.toLowerCase().trim()}`);
    const norm = normalizeTrackTitle(t);
    if (norm) seen.add(`norm:${norm}`);
  };

  add(lastTrack);
  for (const prev of player?.queue?.previous || []) {
    add(prev);
  }
  return seen;
}

function pickFreshTrack(tracks, seen) {
  if (!Array.isArray(tracks)) return null;
  return (
    tracks.find((t) => {
      if (!t?.info || t.info.isStream) return false;
      if (t.info.duration > MAX_AUTOPLAY_DURATION_MS) return false;
      if (t.info.identifier && seen.has(`id:${t.info.identifier}`)) return false;
      if (t.info.isrc && seen.has(`isrc:${t.info.isrc}`)) return false;
      if (t.info.title && seen.has(`raw:${t.info.title.toLowerCase().trim()}`)) return false;
      const norm = normalizeTrackTitle(t);
      if (norm && seen.has(`norm:${norm}`)) return false;
      return true;
    }) || null
  );
}

/**
 * Create the LavalinkManager `onEmptyQueue.autoPlayFunction` handler.
 *
 * @param {{ config: ReturnType<import("../config.js").loadConfig>, guildSettings: import("./guildSettings.js").GuildSettingsStore }} deps
 */
export function createAutoplayHandler({ config, guildSettings }) {
  return async function autoPlayFunction(player, lastTrack) {
    if (!player || !lastTrack) return;
    if (player.getData?.("_recoveringTrack")) return;
    if (!guildSettings.isAutoplay(player.guildId)) return;

    const seen = buildPlayedHistorySet(player, lastTrack);
    const requester = { id: null, username: "Autoplay" };
    const nodeSources = getNodeSources(player);

    let nextTrack = null;

    // 1. YouTube Radio Mix (highest quality related songs when last track is on YouTube)
    const id = lastTrack.info?.identifier;
    if (
      !nextTrack &&
      id &&
      YOUTUBE_ID_RE.test(id) &&
      (lastTrack.info?.sourceName === "youtube" ||
        lastTrack.info?.sourceName === "youtubemusic" ||
        lastTrack.info?.sourceName === "ytmusic")
    ) {
      try {
        const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
        const res = await player.search({ query: mixUrl }, requester);
        nextTrack = pickFreshTrack(res?.tracks, seen);
      } catch {
        // Fall through
      }
    }

    // 2. Spotify Recommendations (if the active node has LavaSrc Spotify enabled)
    if (!nextTrack && nodeSources.has("spotify") && lastTrack.info?.sourceName === "spotify" && id) {
      try {
        const res = await player.search({ query: `seed_tracks=${id}`, source: "sprec" }, requester);
        nextTrack = pickFreshTrack(res?.tracks, seen);
      } catch {
        // Fall through
      }
    }

    // 3. Universal multi-platform artist fallback (works on every node & platform)
    if (!nextTrack) {
      const clientData = lastTrack.pluginInfo?.clientData || {};
      const author = clientData.originAuthor || lastTrack.info?.author || "";
      const title = clientData.originTitle || lastTrack.info?.title || "";
      const query = author ? `${author} songs` : title;
      if (query) {
        try {
          const res = await searchWithFallback(player, query, requester, config.defaultSearchPlatform);
          nextTrack = pickFreshTrack(res?.tracks, seen);
        } catch {
          // ignore
        }
      }
    }

    if (nextTrack) {
      await player.queue.add(nextTrack);
    }
  };
}
