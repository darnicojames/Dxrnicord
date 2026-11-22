import { TrackSymbol, UnresolvedTrackSymbol } from "lavalink-client";
import { validateExternalUrl } from "../security/guard.js";
import { cleanArtistName, cleanTrackTitle, stripParentheticals } from "./lyrics.js";
import {
  getNodeFailedSources,
  isNodeYoutubeBlocked,
  normalizeSourceName,
} from "./nodeDiscovery.js";

const MAX_FALLBACK_PLAYLIST_TRACKS = 100;
const REQUEST_TIMEOUT_MS = 6000;
const SEARCH_CACHE_TTL_MS = 3 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 40;

/** Lightweight in-memory search cache for instant repeat plays. */
const searchCache = new Map();

const SPOTIFY_URL_RE =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([a-zA-Z0-9]+)/i;
const SPOTIFY_SHORT_RE = /^https?:\/\/(?:spotify\.link|spoti\.fi)\/\S+/i;
const DEEZER_URL_RE =
  /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/i;
const DEEZER_SHORT_RE = /^https?:\/\/(?:dzr\.page\.link|deezer\.page\.link|link\.deezer\.com)\/\S+/i;
const APPLE_MUSIC_RE =
  /^https?:\/\/music\.apple\.com\/([a-z]{2})\/(album|song|playlist)\/[^?#]*?\/(?:id)?([a-zA-Z0-9.]+)(?:\?[^#]*)?/i;
const YOUTUBE_RE =
  /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/\S+/i;
const SOUNDCLOUD_RE =
  /^https?:\/\/(?:www\.|m\.|on\.)?soundcloud\.com\/\S+/i;
const BANDCAMP_RE = /^https?:\/\/[^/\s]+\.bandcamp\.com\/\S+/i;
const TWITCH_RE = /^https?:\/\/(?:www\.|m\.)?twitch\.tv\/\S+/i;
const VIMEO_RE = /^https?:\/\/(?:www\.)?vimeo\.com\/\S+/i;
const HTTP_URL_RE = /^https?:\/\/\S+/i;

const SHORT_SOURCE_PREFIXES = {
  yt: "ytsearch",
  youtube: "ytsearch",
  ytm: "ytmsearch",
  sp: "spsearch",
  spotify: "spsearch",
  sc: "scsearch",
  soundcloud: "scsearch",
  dz: "dzsearch",
  deezer: "dzsearch",
};

const MULTI_SOURCE_SEARCH_SET = [
  { prefix: "ytmsearch", label: "YouTube Music", manager: "youtube" },
  { prefix: "spsearch", label: "Spotify", manager: "spotify" },
  { prefix: "dzsearch", label: "Deezer", manager: "deezer" },
  { prefix: "scsearch", label: "SoundCloud", manager: "soundcloud" },
];

const UNWANTED_VARIANT_TERMS = [
  "remix",
  "cover",
  "nightcore",
  "slowed",
  "reverb",
  "sped up",
  "karaoke",
  "instrumental",
  "8d",
  "1 hour",
  "10 hour",
  "loop",
  "tribute",
  "parody",
  "live",
];

/** Cached Spotify app access token when optional SPOTIFY_CLIENT_ID/SECRET are set. */
let cachedSpotifyToken = { token: "", expiresAt: 0 };

function getCachedSearch(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedSearch(key, value) {
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
}

/**
 * Check whether user input explicitly starts with a source prefix (`yt:`, `sp:`, `dz:`, `sc:`, etc.).
 * @param {string} rawQuery
 */
export function hasExplicitSourcePrefix(rawQuery) {
  const trimmed = String(rawQuery || "").trim();
  if (/^https?:\/\//i.test(trimmed)) return false;
  const match = trimmed.match(/^([a-z]+):(.+)$/i);
  return Boolean(match && SHORT_SOURCE_PREFIXES[match[1].toLowerCase()] && match[2].trim());
}

/**
 * Parse optional source shorthand prefix like `sc:lofi beats`, `sp:song`, or `yt:song`.
 * Leaves full URLs (`http://`, `https://`) untouched.
 * @param {string} rawQuery
 * @param {string} defaultSource
 */
export function parseSourceOverride(rawQuery, defaultSource = "ytmsearch") {
  const trimmed = String(rawQuery || "").trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { query: trimmed, source: defaultSource };
  }
  const match = trimmed.match(/^([a-z]+):(.+)$/i);
  if (match) {
    const mapped = SHORT_SOURCE_PREFIXES[match[1].toLowerCase()];
    if (mapped && match[2].trim()) {
      return { query: match[2].trim(), source: mapped };
    }
  }
  return { query: trimmed, source: defaultSource };
}

/**
 * Inspect user input and classify it as a platform URL or plain-text search.
 * @param {string} rawInput
 */
export function detectQueryKind(rawInput) {
  const input = String(rawInput || "").trim();

  const spotifyMatch = input.match(SPOTIFY_URL_RE);
  if (spotifyMatch) {
    return {
      kind: "spotify",
      isUrl: true,
      type: spotifyMatch[1].toLowerCase(),
      id: spotifyMatch[2],
      url: input,
    };
  }
  if (SPOTIFY_SHORT_RE.test(input)) {
    return { kind: "spotify-short", isUrl: true, url: input };
  }

  const deezerMatch = input.match(DEEZER_URL_RE);
  if (deezerMatch) {
    return {
      kind: "deezer",
      isUrl: true,
      type: deezerMatch[1].toLowerCase(),
      id: deezerMatch[2],
      url: input,
    };
  }
  if (DEEZER_SHORT_RE.test(input)) {
    return { kind: "deezer-short", isUrl: true, url: input };
  }

  const appleMatch = input.match(APPLE_MUSIC_RE);
  if (appleMatch) {
    const urlObj = safeParseUrl(input);
    const trackIdFromQuery = urlObj?.searchParams.get("i");
    const rawType = appleMatch[2].toLowerCase();
    const id = trackIdFromQuery || appleMatch[3];
    const type = trackIdFromQuery ? "song" : rawType;
    return {
      kind: "applemusic",
      isUrl: true,
      country: appleMatch[1].toLowerCase(),
      type,
      id,
      url: input,
    };
  }

  if (YOUTUBE_RE.test(input)) return { kind: "youtube", isUrl: true, url: input };
  if (SOUNDCLOUD_RE.test(input)) return { kind: "soundcloud", isUrl: true, url: input };
  if (BANDCAMP_RE.test(input)) return { kind: "bandcamp", isUrl: true, url: input };
  if (TWITCH_RE.test(input)) return { kind: "twitch", isUrl: true, url: input };
  if (VIMEO_RE.test(input)) return { kind: "vimeo", isUrl: true, url: input };
  if (HTTP_URL_RE.test(input)) return { kind: "http", isUrl: true, url: input };

  return { kind: "search", isUrl: false, query: input };
}

function safeParseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Expand shortened share links (e.g. spotify.link / dzr.page.link) with SSRF redirect validation.
 */
async function expandShortUrl(url, fetchImpl = fetch) {
  const initialCheck = validateExternalUrl(url);
  if (!initialCheck.ok) {
    throw new Error(initialCheck.error);
  }
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "DiscordMusicBot/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const finalUrl = res.url || url;
    const finalCheck = validateExternalUrl(finalUrl);
    if (!finalCheck.ok) {
      throw new Error("Short link redirected to a blocked internal/private address.");
    }
    return finalUrl;
  } catch (err) {
    if (err?.message?.includes("blocked")) throw err;
    return url;
  }
}

/**
 * Return lowercased set of sourceManagers exposed by the active Lavalink node.
 * @param {any} player
 * @returns {Set<string>}
 */
export function getNodeSources(player) {
  const list = player?.node?.info?.sourceManagers;
  if (!Array.isArray(list)) return new Set();
  return new Set(list.map((s) => String(s).toLowerCase()));
}

/**
 * Map a Lavalink search prefix (e.g. "ytmsearch") to the required node source manager name.
 */
function sourcePrefixToManager(prefix) {
  switch (prefix) {
    case "ytmsearch":
    case "ytsearch":
      return "youtube";
    case "scsearch":
      return "soundcloud";
    case "dzsearch":
    case "dzisrc":
      return "deezer";
    case "spsearch":
      return "spotify";
    case "amsearch":
      return "applemusic";
    case "bcsearch":
      return "bandcamp";
    default:
      return null;
  }
}

function nodeSupportsManager(nodeSources, manager) {
  if (!manager || !nodeSources || nodeSources.size === 0) return true;
  if (nodeSources.has(manager)) return true;
  if (manager === "youtube" && (nodeSources.has("youtubemusic") || nodeSources.has("ytmusic"))) {
    return true;
  }
  if (manager === "deezer" && nodeSources.has("deezerm")) {
    return true;
  }
  return false;
}

/**
 * Build an ordered fallback list of search prefixes compatible with the active node.
 * Routes around ANY source currently marked as failing on this node (e.g. broken Deezer ARL or YouTube IP block).
 *
 * @param {string} preferredSource
 * @param {Set<string>} nodeSources
 * @param {boolean | Set<string>} [failedSourcesOrYtBlocked]
 */
export function buildSearchFallbackOrder(
  preferredSource,
  nodeSources,
  failedSourcesOrYtBlocked = false,
) {
  const failed =
    failedSourcesOrYtBlocked instanceof Set
      ? failedSourcesOrYtBlocked
      : failedSourcesOrYtBlocked === true
        ? new Set(["youtube"])
        : new Set();

  const baseOrder = [preferredSource || "ytmsearch", "dzsearch", "scsearch", "ytmsearch", "ytsearch"];
  const deduped = [...new Set(baseOrder.filter(Boolean))];

  const supported =
    nodeSources && nodeSources.size > 0
      ? deduped.filter((prefix) => nodeSupportsManager(nodeSources, sourcePrefixToManager(prefix)))
      : deduped;

  const list = supported.length > 0 ? supported : deduped;
  if (failed.size === 0) return list;

  // Put healthy (non-failed) sources first; keep failed sources only as last resort
  const healthyFirst = list.filter((p) => !failed.has(sourcePrefixToManager(p)));
  const failedLast = list.filter((p) => failed.has(sourcePrefixToManager(p)));
  return [...healthyFirst, ...failedLast];
}

/**
 * Search for a plain-text query across fallback platforms until tracks are found.
 */
export async function searchWithFallback(player, query, requester, preferredSource) {
  const nodeSources = getNodeSources(player);
  const failedSources = getNodeFailedSources(player?.node?.options?.id);
  const sourcesToTry = buildSearchFallbackOrder(preferredSource, nodeSources, failedSources);
  let lastError = null;

  for (const source of sourcesToTry) {
    try {
      const result = await player.search({ query, source }, requester);
      if (
        result &&
        result.loadType !== "empty" &&
        result.loadType !== "error" &&
        result.tracks?.length > 0
      ) {
        return result;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return {
    loadType: "empty",
    tracks: [],
    playlist: null,
    exception: null,
    pluginInfo: {},
  };
}

function normalizeMatchText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(str) {
  const all = normalizeMatchText(str).split(" ").filter(Boolean);
  const meaningful = all.filter((w) => w.length >= 2);
  return meaningful.length > 0 ? meaningful : all;
}

/**
 * Score how accurately a candidate track matches the user's plain-text search query
 * across YouTube, Spotify, Deezer, and SoundCloud.
 *
 * @param {any} track
 * @param {string} query
 * @param {{ preferredSource?: string, failedSources?: Set<string>, rankIndex?: number }} [opts]
 */
export function scoreTrackRelevance(
  track,
  query,
  { preferredSource = "ytmsearch", failedSources = new Set(), rankIndex = 0 } = {},
) {
  if (!track?.info?.title) return -1000;

  const normQuery = normalizeMatchText(query);
  const queryTokens = tokenizeQuery(query);
  if (!normQuery || queryTokens.length === 0) return 0;

  const rawTitle = String(track.info.title || "");
  const stripped = stripParentheticals(rawTitle) || rawTitle;
  const normTitle = normalizeMatchText(rawTitle);
  const normStripped = normalizeMatchText(stripped);
  const normAuthor = normalizeMatchText(cleanArtistName(track.info.author || ""));
  const combined = `${normTitle} ${normAuthor}`.trim();
  const combinedTokens = new Set(combined.split(" ").filter(Boolean));
  const authorTokens = new Set(normAuthor.split(" ").filter(Boolean));

  let score = 0;

  // 1. Token coverage across title + artist (0..80)
  let matchedTokens = 0;
  let artistMatches = 0;
  for (const tok of queryTokens) {
    if (combinedTokens.has(tok) || combined.includes(tok)) {
      matchedTokens += 1;
    }
    if (authorTokens.has(tok) || (tok.length >= 3 && normAuthor.includes(tok))) {
      artistMatches += 1;
    }
  }
  score += (matchedTokens / queryTokens.length) * 80;

  // 2. Exact / clean title bonuses
  if (normStripped === normQuery || normTitle === normQuery) {
    score += 55;
  } else if (normStripped.startsWith(normQuery) || normTitle.startsWith(normQuery)) {
    score += 30;
  } else if (normQuery.includes(normStripped) && normStripped.length >= 4) {
    // e.g. query = "take it to the head dj khaled", stripped title = "take it to the head"
    score += 35;
  }

  // 3. Artist name match bonus (separates exact artist from random covers/wrong songs)
  if (artistMatches > 0) {
    score += Math.min(artistMatches * 18, 40);
  }

  // 4. Penalize unwanted remixes/covers/slowed/live/karaoke/tribute tracks when user did NOT ask for them
  let variantPenalty = 0;
  for (const term of UNWANTED_VARIANT_TERMS) {
    const termRe = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (termRe.test(combined) && !termRe.test(normQuery)) {
      variantPenalty += 35;
    }
  }
  score -= Math.min(variantPenalty, 55);

  // 5. Duration & preview sanity (penalize 30s previews, SoundCloud Go+ snips, and 1-hour loops)
  const duration = Number(track.info.duration) || 0;
  if (!track.info.isStream && duration > 0) {
    if (duration < 35_000) score -= 50;
    if (duration > 15 * 60_000 && !/\b(mix|hour|album|set|medley|playlist)\b/i.test(normQuery)) {
      score -= 40;
    }
  }
  const scPolicy = String(track.pluginInfo?.policy || "").toUpperCase();
  const scPlayback = String(track.pluginInfo?.playback || "").toUpperCase();
  if (scPolicy === "SNIP" || scPlayback === "PARTIAL") {
    score -= 80;
  }

  // 6. Mild preference for top search rank from the platform itself
  score += rankIndex === 0 ? 10 : rankIndex === 1 ? 4 : 0;

  // 7. Source health & playability preference
  const canonical = normalizeSourceName(track.info.sourceName);
  if (failedSources && failedSources.has(canonical)) {
    score -= 150;
  }
  if (canonical !== "spotify" && canonical !== "applemusic") {
    score += 8; // Prefer directly streamable track over mirror-only metadata on equal match
  }
  if (sourcePrefixToManager(preferredSource) === canonical) {
    score += 10;
  }

  return Math.round(score * 10) / 10;
}

function searchSourceWithTimeout(player, query, source, requester, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });

  return Promise.race([
    player
      .search({ query, source }, requester)
      .then((res) =>
        res && res.loadType !== "empty" && res.loadType !== "error" && res.tracks?.length > 0
          ? res.tracks
          : [],
      )
      .catch(() => []),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * If Spotify won the relevance ranking, try pairing it with an already-fetched healthy direct
 * stream from the same parallel batch (exact ISRC or matching title+artist+duration) for ZERO
 * extra network round-trips!
 */
function findMatchingDirectTrackInBatch(spotifyTrack, candidates, failedSources) {
  const spInfo = spotifyTrack?.info;
  if (!spInfo) return null;

  const spIsrc = spInfo.isrc ? String(spInfo.isrc).trim().toUpperCase() : "";
  const spStripped = normalizeMatchText(stripParentheticals(spInfo.title || "") || spInfo.title || "");
  const spAuthorTokens = new Set(tokenizeQuery(cleanArtistName(spInfo.author || "")));
  const spDur = Number(spInfo.duration) || 0;

  const healthyDirect = candidates.filter((c) => {
    const src = normalizeSourceName(c.track?.info?.sourceName);
    return src && src !== "spotify" && src !== "applemusic" && !failedSources.has(src);
  });

  // 1. Exact studio ISRC match
  if (spIsrc) {
    const byIsrc = healthyDirect.find(
      (c) => c.track?.info?.isrc && String(c.track.info.isrc).trim().toUpperCase() === spIsrc,
    );
    if (byIsrc) return byIsrc.track;
  }

  // 2. Strong title + artist + duration match
  let best = null;
  let bestScore = 0;
  for (const c of healthyDirect) {
    const tInfo = c.track?.info;
    if (!tInfo?.title) continue;
    const tStripped = normalizeMatchText(stripParentheticals(tInfo.title) || tInfo.title);
    const titleMatches =
      tStripped === spStripped ||
      (spStripped.length >= 4 && (tStripped.includes(spStripped) || spStripped.includes(tStripped)));
    if (!titleMatches) continue;

    const tAuthor = normalizeMatchText(cleanArtistName(tInfo.author || ""));
    const authorOverlap = [...spAuthorTokens].some((tok) => tok.length >= 3 && tAuthor.includes(tok));
    if (!authorOverlap && spAuthorTokens.size > 0) continue;

    const tDur = Number(tInfo.duration) || 0;
    const durOk = spDur <= 0 || tDur <= 0 || Math.abs(tDur - spDur) <= 10_000;
    if (!durOk) continue;

    if (c.score > bestScore) {
      bestScore = c.score;
      best = c.track;
    }
  }
  return best;
}

const EXPLICIT_TEXT_RE = /\b(explicit|uncensored|dirty)\b/i;

/**
 * Lightweight keyless explicit-lyrics check via Deezer's public catalog search API (~250ms),
 * run in parallel with the 4 Lavalink searches so it adds zero latency.
 */
async function checkExplicitViaDeezerApi(query, fetchImpl = fetch, timeoutMs = 1300) {
  if (typeof fetchImpl !== "function") return false;
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return false;

  try {
    const res = await fetchImpl(
      `https://api.deezer.com/search?limit=2&q=${encodeURIComponent(query)}`,
      {
        headers: { Accept: "application/json", "User-Agent": "DiscordMusicBot/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res?.ok) return false;
    const json = await res.json();
    const items = Array.isArray(json?.data) ? json.data : [];
    for (const item of items) {
      if (!item?.title) continue;
      const combined = normalizeMatchText(`${item.title} ${item.artist?.name || ""}`);
      const hits = queryTokens.filter((tok) => combined.includes(tok)).length;
      if (hits / queryTokens.length >= 0.5) {
        return Boolean(item.explicit_lyrics);
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect whether the matched song is explicit from query text, track titles/metadata,
 * or the parallel Deezer catalog explicit_lyrics flag.
 */
export function detectExplicitFromCandidates(query, scoredCandidates, apiExplicitFlag = false) {
  if (EXPLICIT_TEXT_RE.test(String(query || ""))) return true;
  if (apiExplicitFlag) return true;

  const topScore = scoredCandidates?.[0]?.score ?? 0;
  for (const c of scoredCandidates || []) {
    if (c.score < Math.max(40, topScore - 35)) continue;
    const t = c.track;
    if (t?.info?.isExplicit === true || t?.pluginInfo?.isExplicit === true) return true;
    if (EXPLICIT_TEXT_RE.test(String(t?.info?.title || ""))) return true;
  }
  return false;
}

/**
 * Search YouTube Music, Spotify, Deezer, and SoundCloud IN PARALLEL and rank every result
 * by exact-match relevance:
 * - Explicit songs prefer healthy non-YouTube sources (Deezer / SoundCloud / Spotify) to avoid YouTube login/age gates.
 * - Non-explicit songs prefer YouTube when YouTube finds a strong match, falling back to alternative sources otherwise.
 *
 * @param {any} player
 * @param {string} query
 * @param {any} requester
 * @param {{ preferredSource?: string, perSourceLimit?: number, maxTotal?: number, timeoutMs?: number, materializeWinner?: boolean, fetchImpl?: typeof fetch }} [opts]
 */
export async function searchAllSources(
  player,
  query,
  requester,
  {
    preferredSource = "ytmsearch",
    perSourceLimit = 3,
    maxTotal = 8,
    timeoutMs = 1800,
    materializeWinner = true,
    fetchImpl = fetch,
  } = {},
) {
  const nodeSources = getNodeSources(player);
  const failedSources = getNodeFailedSources(player?.node?.options?.id);

  // Select supported platforms from our 4-source set (YouTube, Spotify, Deezer, SoundCloud)
  let activeSpecs = MULTI_SOURCE_SEARCH_SET.filter(
    (s) => nodeSupportsManager(nodeSources, s.manager) && !failedSources.has(s.manager),
  );
  if (activeSpecs.length === 0) {
    activeSpecs = MULTI_SOURCE_SEARCH_SET.filter((s) => nodeSupportsManager(nodeSources, s.manager));
  }
  if (activeSpecs.length === 0) {
    activeSpecs = MULTI_SOURCE_SEARCH_SET;
  }

  // Fire all 4 platform searches + keyless explicit metadata check IN PARALLEL (zero extra latency!)
  const [batches, apiExplicit] = await Promise.all([
    Promise.all(
      activeSpecs.map(async (spec) => {
        const tracks = await searchSourceWithTimeout(player, query, spec.prefix, requester, timeoutMs);
        return { spec, tracks: Array.isArray(tracks) ? tracks.slice(0, perSourceLimit) : [] };
      }),
    ),
    checkExplicitViaDeezerApi(query, fetchImpl, Math.min(1300, timeoutMs)),
  ]);

  // If no strong match came back (e.g. YouTube-only upload/live video not on YTM/Spotify/Deezer/SC),
  // run a fast standard `ytsearch` supplement when YouTube isn't blocked.
  const initialCount = batches.reduce((acc, b) => acc + b.tracks.length, 0);
  const scoredInitial = [];
  for (const { spec, tracks } of batches) {
    tracks.forEach((track, idx) => {
      scoredInitial.push({
        track,
        spec,
        rankIndex: idx,
        score: scoreTrackRelevance(track, query, { preferredSource, failedSources, rankIndex: idx }),
      });
    });
  }

  const topInitialScore = scoredInitial.reduce((m, c) => Math.max(m, c.score), -Infinity);
  if (
    (initialCount === 0 || topInitialScore < 55) &&
    nodeSupportsManager(nodeSources, "youtube") &&
    !failedSources.has("youtube")
  ) {
    const ytTracks = await searchSourceWithTimeout(player, query, "ytsearch", requester, timeoutMs);
    if (Array.isArray(ytTracks) && ytTracks.length > 0) {
      const ytSpec = { prefix: "ytsearch", label: "YouTube", manager: "youtube" };
      batches.push({ spec: ytSpec, tracks: ytTracks.slice(0, perSourceLimit) });
      ytTracks.slice(0, perSourceLimit).forEach((track, idx) => {
        scoredInitial.push({
          track,
          spec: ytSpec,
          rankIndex: idx,
          score: scoreTrackRelevance(track, query, { preferredSource, failedSources, rankIndex: idx }),
        });
      });
    }
  }

  if (scoredInitial.length === 0) {
    return {
      bestTrack: null,
      rankedTracks: [],
      respondedSources: [],
      isExplicit: false,
    };
  }

  // Track which platforms returned results (preserving clean display order)
  const respondedSources = [
    ...new Set(batches.filter((b) => b.tracks.length > 0).map((b) => b.spec.label)),
  ];

  // Global relevance sort
  scoredInitial.sort((a, b) => b.score - a.score);

  const isExplicit = detectExplicitFromCandidates(query, scoredInitial, apiExplicit);

  // Build diverse top list for `d!search` (best track per platform first, then top remaining by score)
  // Deduplicate identical (source + title + author) album/single duplicates from the same platform!
  const diverse = [];
  const seenKeys = new Set();
  const trackKey = (t) =>
    `${normalizeSourceName(t.info?.sourceName)}|${normalizeMatchText(t.info?.title)}|${normalizeMatchText(t.info?.author)}`;

  // Pass 1: top #1 match from each responding platform (sorted by score)
  const bestPerPlatform = [];
  const seenManagers = new Set();
  for (const item of scoredInitial) {
    if (seenManagers.has(item.spec.manager)) continue;
    seenManagers.add(item.spec.manager);
    bestPerPlatform.push(item);
  }
  bestPerPlatform.sort((a, b) => b.score - a.score);

  for (const item of bestPerPlatform) {
    if (diverse.length >= maxTotal) break;
    const key = trackKey(item.track);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    diverse.push(item.track);
  }

  // Pass 2: fill remaining slots up to `maxTotal` with highest-scoring tracks overall
  for (const item of scoredInitial) {
    if (diverse.length >= maxTotal) break;
    const key = trackKey(item.track);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    diverse.push(item.track);
  }

  // Explicit-aware winner selection for `d!play`:
  // - Explicit song -> prefer healthy non-YouTube sources (Deezer / SoundCloud / Spotify)
  // - Non-explicit song -> prefer YouTube when YouTube found a strong match; else fall back to best alternative source
  const topScore = scoredInitial[0].score;
  let winnerItem = scoredInitial[0];

  if (isExplicit) {
    const nonYtCandidate = scoredInitial.find((c) => {
      const mgr = normalizeSourceName(c.track?.info?.sourceName) || c.spec.manager;
      return (
        mgr !== "youtube" &&
        !failedSources.has(mgr) &&
        c.score >= Math.max(45, topScore - 35)
      );
    });
    if (nonYtCandidate) {
      winnerItem = nonYtCandidate;
    }
  } else if (!failedSources.has("youtube")) {
    const ytCandidate = scoredInitial.find((c) => {
      const mgr = normalizeSourceName(c.track?.info?.sourceName) || c.spec.manager;
      return mgr === "youtube" && c.score >= Math.max(55, topScore - 25);
    });
    if (ytCandidate) {
      winnerItem = ytCandidate;
    }
  }

  let bestTrack = winnerItem.track;
  const bestSrc = normalizeSourceName(bestTrack?.info?.sourceName);

  if (materializeWinner && (bestSrc === "spotify" || bestSrc === "applemusic")) {
    // For explicit songs, prefer pairing Spotify with a non-YouTube direct stream first
    const batchPool = isExplicit
      ? scoredInitial.filter(
          (c) => (normalizeSourceName(c.track?.info?.sourceName) || c.spec.manager) !== "youtube",
        )
      : scoredInitial;
    const batchMatch =
      findMatchingDirectTrackInBatch(bestTrack, batchPool, failedSources) ||
      (isExplicit ? findMatchingDirectTrackInBatch(bestTrack, scoredInitial, failedSources) : null);

    if (batchMatch) {
      bestTrack = tagOriginMetadata(batchMatch, {
        title: bestTrack.info.title,
        author: bestTrack.info.author,
        duration: Number(bestTrack.info.duration) || 0,
        isrc: bestTrack.info.isrc || null,
        artworkUrl: bestTrack.info.artworkUrl || bestTrack.pluginInfo?.artworkUrl || null,
        uri: bestTrack.info.uri || null,
        platform: bestSrc,
      });
    } else {
      bestTrack = await materializeDirectTrack(
        player,
        bestTrack,
        requester,
        isExplicit ? "dzsearch" : preferredSource,
      );
    }
  }

  return {
    bestTrack,
    rankedTracks: diverse,
    respondedSources,
    isExplicit,
  };
}

/**
 * Keyless YouTube oEmbed metadata lookup (immune to YouTube InnerTube bot/login IP blocks).
 * Used to rescue pasted YouTube links via Deezer/SoundCloud when a public node's YouTube IP is blocked.
 */
export async function fetchYoutubeOembedMetadata(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      {
        headers: { Accept: "application/json", "User-Agent": "DiscordMusicBot/1.0" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.title) return null;
    return {
      title: String(json.title).trim(),
      author: cleanArtistName(json.author_name || ""),
      artworkUrl: json.thumbnail_url || null,
      uri: url,
      platform: "youtube",
    };
  } catch {
    return null;
  }
}

/**
 * Pre-resolve mirror-only tracks (Spotify / Apple Music from LavaSrc) into an immediately
 * streamable direct track, routing around any source known to fail on the active node.
 */
export async function materializeDirectTrack(player, track, requester, preferredSource) {
  if (!track?.info) return track;
  const src = String(track.info.sourceName || "").toLowerCase();
  if (src !== "spotify" && src !== "applemusic") return track;

  const nodeId = player?.node?.options?.id;
  const nodeSources = getNodeSources(player);
  const failedSources = getNodeFailedSources(nodeId);
  const originItem = {
    title: track.info.title,
    author: track.info.author,
    duration: Number(track.info.duration) || 0,
    isrc: track.info.isrc || null,
    artworkUrl: track.info.artworkUrl || track.pluginInfo?.artworkUrl || null,
    uri: track.info.uri || null,
    platform: src,
  };

  // 1. Exact studio-master ISRC match on Deezer CDN (skipped if Deezer is failing on this node!)
  if (originItem.isrc && nodeSupportsManager(nodeSources, "deezer") && !failedSources.has("deezer")) {
    try {
      const isrcRes = await player.search(
        { query: originItem.isrc, source: "dzisrc" },
        requester,
      );
      if (isrcRes?.tracks?.length > 0) {
        return tagOriginMetadata(isrcRes.tracks[0], originItem);
      }
    } catch {
      // Fall through to search
    }
  }

  // 2. Fast direct search across healthy node sources
  const searchText = [originItem.title, originItem.author].filter(Boolean).join(" ");
  const preferred = !failedSources.has("deezer") && nodeSupportsManager(nodeSources, "deezer")
    ? "dzsearch"
    : preferredSource || "ytmsearch";
  const supported = buildSearchFallbackOrder(preferred, nodeSources, failedSources);

  for (const source of supported) {
    try {
      const res = await player.search({ query: searchText, source }, requester);
      if (res?.tracks?.length > 0) {
        const matched = pickBestMatch(res.tracks, originItem);
        if (matched) return tagOriginMetadata(matched, originItem);
      }
    } catch {
      // Try next fast mirror
    }
  }

  // Fallback to original track if no direct mirror matched
  return track;
}

/**
 * Resolve an alternate playable mirror when a track stalls (`trackStuck`) or errors (`trackError`).
 * - On the same node (`allowSameSource: false`): switches away from `failedSource` and any known-broken sources on that node.
 * - After migrating to a fresh healthy node (`allowSameSource: true`): searches healthy sources on the new node (including ytmsearch).
 */
export async function resolveAlternateMirror(
  player,
  failedTrack,
  requester,
  { allowSameSource = false } = {},
) {
  if (!player || !failedTrack?.info) return null;

  const clientData = failedTrack.pluginInfo?.clientData || {};
  const title = clientData.originTitle || failedTrack.info.title;
  const author = clientData.originAuthor || failedTrack.info.author;
  const failedSource = normalizeSourceName(failedTrack.info.sourceName);
  const nodeId = player?.node?.options?.id;
  const nodeSources = getNodeSources(player);
  const nodeFailed = getNodeFailedSources(nodeId);

  const blocked = new Set(nodeFailed);
  if (!allowSameSource && failedSource) {
    blocked.add(failedSource);
  }

  const originItem = {
    title,
    author,
    duration: Number(failedTrack.info.duration) || 0,
    isrc: failedTrack.info.isrc || null,
    artworkUrl: clientData.originArtworkUrl || failedTrack.info.artworkUrl || null,
    uri: clientData.originUrl || failedTrack.info.uri || null,
    platform: clientData.originPlatform || failedSource,
  };

  // Try Deezer ISRC first if available and Deezer isn't blocked on this node
  if (originItem.isrc && !blocked.has("deezer") && nodeSupportsManager(nodeSources, "deezer")) {
    try {
      const res = await player.search({ query: originItem.isrc, source: "dzisrc" }, requester);
      if (res?.tracks?.length > 0) {
        return tagOriginMetadata(res.tracks[0], originItem);
      }
    } catch {
      // continue
    }
  }

  const preferredOrder = allowSameSource
    ? ["ytmsearch", "dzsearch", "scsearch", "ytsearch"]
    : ["dzsearch", "scsearch", "ytmsearch", "ytsearch"];

  const candidateOrder = preferredOrder.filter((prefix) => {
    const mgr = sourcePrefixToManager(prefix);
    if (mgr && blocked.has(mgr)) return false;
    return nodeSupportsManager(nodeSources, mgr);
  });

  if (candidateOrder.length === 0) return null;

  const cleanedTitle = cleanTrackTitle(title) || title;
  const strippedTitle = stripParentheticals(title) || cleanedTitle;
  const cleanedAuthor = cleanArtistName(author) || author;
  const searchVariants = [
    [cleanedTitle, cleanedAuthor].filter(Boolean).join(" "),
    [strippedTitle, cleanedAuthor].filter(Boolean).join(" "),
    strippedTitle,
    [title, author].filter(Boolean).join(" "),
  ].filter((q, idx, arr) => q && arr.indexOf(q) === idx);

  for (const source of candidateOrder) {
    for (const searchText of searchVariants) {
      try {
        const res = await player.search({ query: searchText, source }, requester);
        if (
          res &&
          res.loadType !== "empty" &&
          res.loadType !== "error" &&
          res.tracks?.length > 0
        ) {
          const matched = pickBestMatch(res.tracks, originItem);
          if (matched) return tagOriginMetadata(matched, originItem);
        }
      } catch {
        // continue
      }
    }
  }

  return null;
}

/**
 * Parse Spotify embed HTML (__NEXT_DATA__ script JSON) into track metadata with ZERO API keys.
 * Exported for unit testing.
 */
export function parseSpotifyEmbedHtml(html, type, originalUrl) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) return null;

  const coverUrl =
    entity.visualIdentity?.image?.[0]?.url ||
    entity.coverArt?.sources?.[0]?.url ||
    null;

  if (type === "track" || entity.type === "track") {
    const title = entity.name || entity.title;
    if (!title) return null;
    const artists = Array.isArray(entity.artists)
      ? entity.artists.map((a) => a?.name).filter(Boolean).join(", ")
      : entity.subtitle || "";

    return {
      isPlaylist: false,
      playlistName: null,
      playlistUrl: originalUrl,
      artworkUrl: coverUrl,
      items: [
        {
          title,
          author: artists,
          duration: Number(entity.duration) || 0,
          artworkUrl: coverUrl,
          uri: originalUrl,
          platform: "spotify",
        },
      ],
    };
  }

  const trackList = Array.isArray(entity.trackList) ? entity.trackList : [];
  const items = trackList
    .slice(0, MAX_FALLBACK_PLAYLIST_TRACKS)
    .map((item) => {
      const title = item?.title || item?.name;
      if (!title) return null;
      return {
        title,
        author: item?.subtitle || "",
        duration: Number(item?.duration) || 0,
        artworkUrl: coverUrl,
        uri: item?.uri ? spotifyUriToUrl(item.uri) : originalUrl,
        platform: "spotify",
      };
    })
    .filter(Boolean);

  if (items.length === 0) return null;

  return {
    isPlaylist: true,
    playlistName: entity.name || entity.title || "Spotify Collection",
    playlistUrl: originalUrl,
    artworkUrl: coverUrl,
    items,
  };
}

function spotifyUriToUrl(uri) {
  const match = String(uri || "").match(/^spotify:(track|album|playlist):([a-zA-Z0-9]+)$/);
  if (!match) return null;
  return `https://open.spotify.com/${match[1]}/${match[2]}`;
}

/**
 * Optional Spotify official Web API client-credentials lookup (only used if user configured keys).
 */
async function fetchSpotifyViaApi(type, id, originalUrl, config, fetchImpl = fetch) {
  if (!config?.spotifyClientId || !config?.spotifyClientSecret) return null;

  try {
    if (!cachedSpotifyToken.token || Date.now() >= cachedSpotifyToken.expiresAt - 60_000) {
      const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
      const tokenRes = await fetchImpl("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!tokenRes.ok) return null;
      const tokenJson = await tokenRes.json();
      cachedSpotifyToken = {
        token: tokenJson.access_token,
        expiresAt: Date.now() + (Number(tokenJson.expires_in) || 3600) * 1000,
      };
    }

    const endpoint =
      type === "track"
        ? `https://api.spotify.com/v1/tracks/${id}`
        : type === "album"
          ? `https://api.spotify.com/v1/albums/${id}`
          : `https://api.spotify.com/v1/playlists/${id}?fields=name,images,tracks.items(track(name,duration_ms,external_ids,external_urls,artists(name),album(images)))`;

    const res = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${cachedSpotifyToken.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();

    if (type === "track") {
      return {
        isPlaylist: false,
        playlistName: null,
        playlistUrl: originalUrl,
        artworkUrl: json.album?.images?.[0]?.url || null,
        items: [
          {
            title: json.name,
            author: (json.artists || []).map((a) => a.name).join(", "),
            duration: Number(json.duration_ms) || 0,
            isrc: json.external_ids?.isrc || null,
            artworkUrl: json.album?.images?.[0]?.url || null,
            uri: json.external_urls?.spotify || originalUrl,
            platform: "spotify",
          },
        ],
      };
    }

    if (type === "album") {
      const albumArt = json.images?.[0]?.url || null;
      const items = (json.tracks?.items || [])
        .slice(0, MAX_FALLBACK_PLAYLIST_TRACKS)
        .map((t) => ({
          title: t.name,
          author: (t.artists || []).map((a) => a.name).join(", "),
          duration: Number(t.duration_ms) || 0,
          artworkUrl: albumArt,
          uri: t.external_urls?.spotify || originalUrl,
          platform: "spotify",
        }));
      return {
        isPlaylist: true,
        playlistName: json.name || "Spotify Album",
        playlistUrl: originalUrl,
        artworkUrl: albumArt,
        items,
      };
    }

    const coverArt = json.images?.[0]?.url || null;
    const items = (json.tracks?.items || [])
      .map((entry) => entry?.track)
      .filter((t) => t && t.name)
      .slice(0, MAX_FALLBACK_PLAYLIST_TRACKS)
      .map((t) => ({
        title: t.name,
        author: (t.artists || []).map((a) => a.name).join(", "),
        duration: Number(t.duration_ms) || 0,
        isrc: t.external_ids?.isrc || null,
        artworkUrl: t.album?.images?.[0]?.url || coverArt,
        uri: t.external_urls?.spotify || originalUrl,
        platform: "spotify",
      }));

    return {
      isPlaylist: true,
      playlistName: json.name || "Spotify Playlist",
      playlistUrl: originalUrl,
      artworkUrl: coverArt,
      items,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch Spotify track/album/playlist metadata without requiring API keys.
 */
export async function fetchSpotifyMetadata(type, id, originalUrl, config, fetchImpl = fetch) {
  const fromApi = await fetchSpotifyViaApi(type, id, originalUrl, config, fetchImpl);
  if (fromApi && fromApi.items.length > 0) return fromApi;

  try {
    const embedRes = await fetchImpl(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (embedRes.ok) {
      const html = await embedRes.text();
      const parsed = parseSpotifyEmbedHtml(html, type, originalUrl);
      if (parsed && parsed.items.length > 0) return parsed;
    }
  } catch {
    // Fall through to oEmbed
  }

  if (type === "track") {
    try {
      const oembedRes = await fetchImpl(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(originalUrl)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (oembedRes.ok) {
        const json = await oembedRes.json();
        if (json?.title) {
          return {
            isPlaylist: false,
            playlistName: null,
            playlistUrl: originalUrl,
            artworkUrl: json.thumbnail_url || null,
            items: [
              {
                title: json.title,
                author: "",
                duration: 0,
                artworkUrl: json.thumbnail_url || null,
                uri: originalUrl,
                platform: "spotify",
              },
            ],
          };
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Fetch Deezer track/album/playlist metadata via Deezer's free keyless public JSON API.
 */
export async function fetchDeezerMetadata(type, id, originalUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://api.deezer.com/${type}/${id}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.error) return null;

    if (type === "track") {
      return {
        isPlaylist: false,
        playlistName: null,
        playlistUrl: originalUrl,
        artworkUrl: json.album?.cover_big || json.album?.cover_medium || null,
        items: [
          {
            title: json.title,
            author: json.artist?.name || "",
            duration: (Number(json.duration) || 0) * 1000,
            isrc: json.isrc || null,
            artworkUrl: json.album?.cover_big || json.album?.cover_medium || null,
            uri: json.link || originalUrl,
            platform: "deezer",
          },
        ],
      };
    }

    const cover = json.cover_big || json.picture_big || json.cover_medium || null;
    const tracks = Array.isArray(json.tracks?.data) ? json.tracks.data : [];
    const items = tracks.slice(0, MAX_FALLBACK_PLAYLIST_TRACKS).map((t) => ({
      title: t.title,
      author: t.artist?.name || "",
      duration: (Number(t.duration) || 0) * 1000,
      artworkUrl: t.album?.cover_medium || cover,
      uri: t.link || originalUrl,
      platform: "deezer",
    }));

    if (items.length === 0) return null;

    return {
      isPlaylist: true,
      playlistName: json.title || "Deezer Collection",
      playlistUrl: originalUrl,
      artworkUrl: cover,
      items,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch Apple Music song/album metadata via Apple's free keyless iTunes Lookup API.
 */
export async function fetchAppleMusicMetadata(type, id, country, originalUrl, fetchImpl = fetch) {
  if (!/^\d+$/.test(String(id))) return null;

  try {
    const url = `https://itunes.apple.com/lookup?id=${id}&country=${encodeURIComponent(country || "us")}&entity=song`;
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results = Array.isArray(json?.results) ? json.results : [];
    if (results.length === 0) return null;

    const collection = results.find((r) => r.wrapperType === "collection");
    const songs = results.filter((r) => r.wrapperType === "track" && r.trackName);
    if (songs.length === 0) return null;

    const toArt = (u) => (u ? u.replace(/100x100bb/i, "600x600bb") : null);

    const items = songs.slice(0, MAX_FALLBACK_PLAYLIST_TRACKS).map((s) => ({
      title: s.trackName,
      author: s.artistName || "",
      duration: Number(s.trackTimeMillis) || 0,
      artworkUrl: toArt(s.artworkUrl100),
      uri: s.trackViewUrl || originalUrl,
      platform: "applemusic",
    }));

    return {
      isPlaylist: type === "album" && items.length > 1,
      playlistName: collection?.collectionName || items[0].title,
      playlistUrl: originalUrl,
      artworkUrl: toArt(collection?.artworkUrl100 || songs[0]?.artworkUrl100),
      items,
    };
  } catch {
    return null;
  }
}

/**
 * Attach friendly origin metadata to a resolved Track without breaking Lavalink's playback fields.
 */
function tagOriginMetadata(track, item) {
  if (!track || !item) return track;
  track.pluginInfo = {
    ...(track.pluginInfo || {}),
    clientData: {
      ...(track.pluginInfo?.clientData || {}),
      originPlatform: item.platform,
      originUrl: item.uri,
      originTitle: item.title,
      originAuthor: item.author,
      originArtworkUrl: item.artworkUrl,
    },
  };
  if (item.artworkUrl && !track.info?.artworkUrl) {
    track.info.artworkUrl = item.artworkUrl;
  }
  return track;
}

/**
 * Build a lazy UnresolvedTrack for tracks #2..N of a fallback-resolved playlist.
 */
function buildLazyFallbackTrack(player, item, requester, preferredSource) {
  const searchQuery = [item.title, item.author].filter(Boolean).join(" - ");
  const unresolved = player.LavalinkManager.utils.buildUnresolvedTrack(
    {
      title: item.title,
      author: item.author || "Unknown Artist",
      duration: item.duration || 0,
      artworkUrl: item.artworkUrl || undefined,
      isrc: item.isrc || undefined,
    },
    requester,
  );

  unresolved.pluginInfo = {
    ...(unresolved.pluginInfo || {}),
    clientData: {
      originPlatform: item.platform,
      originUrl: item.uri,
      originTitle: item.title,
      originAuthor: item.author,
      originArtworkUrl: item.artworkUrl,
    },
  };

  unresolved.resolve = async function resolveWithFallback(activePlayer) {
    const nodeSources = getNodeSources(activePlayer);
    const failedSources = getNodeFailedSources(activePlayer?.node?.options?.id);
    let matched = null;

    if (item.isrc && nodeSupportsManager(nodeSources, "deezer") && !failedSources.has("deezer")) {
      try {
        const res = await activePlayer.search({ query: item.isrc, source: "dzisrc" }, requester);
        if (res?.tracks?.length > 0) matched = res.tracks[0];
      } catch {
        // continue
      }
    }

    if (!matched) {
      const res = await searchWithFallback(activePlayer, searchQuery, requester, preferredSource);
      matched = pickBestMatch(res.tracks, item);
    }

    if (!matched) {
      throw new Error(`Could not find playable stream for "${searchQuery}"`);
    }
    tagOriginMetadata(matched, item);

    for (const prop of Object.getOwnPropertyNames(this)) {
      delete this[prop];
    }
    delete this[UnresolvedTrackSymbol];
    Object.defineProperty(this, TrackSymbol, { configurable: true, value: true });
    return Object.assign(this, matched);
  };

  return unresolved;
}

/**
 * Pick the best matching Lavalink track for a metadata item (prefers close duration match).
 */
export function pickBestMatch(tracks, item) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (item?.duration > 0) {
    const closeDuration = tracks.find(
      (t) =>
        typeof t?.info?.duration === "number" &&
        Math.abs(t.info.duration - item.duration) <= 4000,
    );
    if (closeDuration) return closeDuration;
  }
  return tracks[0];
}

/**
 * Main entry point: resolves ANY user input into fast, immediately playable tracks.
 */
export async function resolveQuery({
  player,
  query,
  requester,
  preferredSource,
  explicitSource = false,
  config,
  fetchImpl = fetch,
}) {
  const nodeId = player?.node?.options?.id || "default";
  const failedSources = getNodeFailedSources(player?.node?.options?.id);
  const cacheKey = `${nodeId}|${explicitSource ? preferredSource || "" : "multi"}|${query.toLowerCase()}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    const cachedSrc = normalizeSourceName(cached.tracks?.[0]?.info?.sourceName);
    if (cachedSrc && failedSources.has(cachedSrc)) {
      // Evict stale cache entry whose source is now failing on this node
      searchCache.delete(cacheKey);
    } else {
      const clonedTracks = cached.tracks.map((t) => ({
        ...t,
        requester,
        pluginInfo: t.pluginInfo ? { ...t.pluginInfo, clientData: { ...(t.pluginInfo.clientData || {}) } } : {},
      }));
      // Restore TrackSymbol on cached resolved tracks
      for (let i = 0; i < clonedTracks.length; i++) {
        if (cached.tracks[i]?.[TrackSymbol]) {
          Object.defineProperty(clonedTracks[i], TrackSymbol, { configurable: true, value: true });
        } else if (cached.tracks[i]?.[UnresolvedTrackSymbol]) {
          clonedTracks[i] = cached.tracks[i];
        }
      }
      return { ...cached, tracks: clonedTracks };
    }
  }

  let detected = detectQueryKind(query);

  // Expand shortened share URLs first (spotify.link, dzr.page.link, etc.)
  if (detected.kind === "spotify-short" || detected.kind === "deezer-short") {
    const expanded = await expandShortUrl(detected.url, fetchImpl);
    detected = detectQueryKind(expanded);
  }

  // Plain-text search:
  // - With explicit prefix (`sc:`, `yt:`, `sp:`, `dz:`): search that specific platform directly
  // - Otherwise: search YouTube, Spotify, Deezer, and SoundCloud IN PARALLEL for the exact song!
  if (!detected.isUrl) {
    if (explicitSource) {
      const res = await searchWithFallback(player, detected.query, requester, preferredSource);
      const tracks = [...(res.tracks || [])];
      if (tracks.length > 0) {
        const topSrc = normalizeSourceName(tracks[0]?.info?.sourceName);
        if (topSrc === "spotify" || topSrc === "applemusic") {
          tracks[0] = await materializeDirectTrack(player, tracks[0], requester, "ytmsearch");
        }
      }
      const out = {
        loadType: res.loadType,
        tracks,
        playlist: res.playlist || null,
        resolvedVia: "search-explicit",
      };
      if (out.tracks.length > 0) setCachedSearch(cacheKey, out);
      return out;
    }

    const multi = await searchAllSources(player, detected.query, requester, {
      preferredSource,
      perSourceLimit: 3,
      maxTotal: 8,
      materializeWinner: true,
      fetchImpl,
    });
    const tracks = multi.bestTrack
      ? [multi.bestTrack, ...multi.rankedTracks.filter((t) => t !== multi.bestTrack)]
      : [];
    const out = {
      loadType: tracks.length > 0 ? "search" : "empty",
      tracks,
      playlist: null,
      resolvedVia: "multi-search",
      respondedSources: multi.respondedSources,
    };
    if (out.tracks.length > 0) setCachedSearch(cacheKey, out);
    return out;
  }

  const nodeSources = getNodeSources(player);
  const ytBlocked = isNodeYoutubeBlocked(player?.node?.options?.id);
  const isMetadataPlatform = ["spotify", "applemusic", "deezer"].includes(detected.kind);
  const nodeSupportsPlatformNatively =
    (!isMetadataPlatform || nodeSources.size === 0 || nodeSupportsManager(nodeSources, detected.kind)) &&
    !(detected.kind === "deezer" && failedSources.has("deezer"));

  // If a YouTube URL is pasted while YouTube is already known bot-blocked on this node,
  // immediately rescue it via keyless YouTube oEmbed -> healthy non-YT source!
  if (
    detected.kind === "youtube" &&
    ytBlocked &&
    ((nodeSupportsManager(nodeSources, "deezer") && !failedSources.has("deezer")) ||
      (nodeSupportsManager(nodeSources, "soundcloud") && !failedSources.has("soundcloud")))
  ) {
    const oembed = await fetchYoutubeOembedMetadata(detected.url, fetchImpl);
    if (oembed) {
      const stripped = stripParentheticals(oembed.title) || oembed.title;
      const queries = [
        [stripped, oembed.author].filter(Boolean).join(" "),
        stripped,
      ].filter((q, idx, arr) => q && arr.indexOf(q) === idx);
      for (const q of queries) {
        const alt = await searchWithFallback(player, q, requester, "dzsearch").catch(() => null);
        if (alt?.tracks?.length > 0) {
          const rescued = tagOriginMetadata(alt.tracks[0], oembed);
          const out = { loadType: "track", tracks: [rescued], playlist: null, resolvedVia: "yt-rescue" };
          setCachedSearch(cacheKey, out);
          return out;
        }
      }
    }
  }

  // 1. Direct Lavalink resolution (and materialize track #1 immediately for Spotify/Apple to avoid mirror stalls!)
  if (nodeSupportsPlatformNatively) {
    try {
      const direct = await player.search({ query: detected.url }, requester);
      if (
        direct &&
        direct.loadType !== "empty" &&
        direct.loadType !== "error" &&
        direct.tracks?.length > 0
      ) {
        const tracks = [...direct.tracks];
        if (detected.kind === "spotify" || detected.kind === "applemusic") {
          tracks[0] = await materializeDirectTrack(player, tracks[0], requester, preferredSource);
        }
        const out = {
          loadType: direct.loadType,
          tracks,
          playlist: direct.playlist || null,
          resolvedVia: "direct",
        };
        setCachedSearch(cacheKey, out);
        return out;
      }
    } catch (err) {
      if (!isMetadataPlatform && detected.kind !== "youtube") {
        throw err;
      }
      // For Spotify/Apple/Deezer/YouTube, fall through to keyless metadata rescue
    }
  }

  // 1b. YouTube URL fallback if direct YouTube load returned empty/error
  if (detected.kind === "youtube") {
    const oembed = await fetchYoutubeOembedMetadata(detected.url, fetchImpl);
    if (oembed) {
      const stripped = stripParentheticals(oembed.title) || oembed.title;
      const alt = await searchWithFallback(
        player,
        [stripped, oembed.author].filter(Boolean).join(" "),
        requester,
        "dzsearch",
      ).catch(() => null);
      if (alt?.tracks?.length > 0) {
        const rescued = tagOriginMetadata(alt.tracks[0], oembed);
        const out = { loadType: "track", tracks: [rescued], playlist: null, resolvedVia: "yt-rescue" };
        setCachedSearch(cacheKey, out);
        return out;
      }
    }
  }

  // 2. Keyless metadata fallback for Spotify, Deezer, and Apple Music
  if (isMetadataPlatform) {
    let metadata = null;
    if (detected.kind === "spotify") {
      metadata = await fetchSpotifyMetadata(detected.type, detected.id, detected.url, config, fetchImpl);
    } else if (detected.kind === "deezer") {
      metadata = await fetchDeezerMetadata(detected.type, detected.id, detected.url, fetchImpl);
    } else if (detected.kind === "applemusic") {
      metadata = await fetchAppleMusicMetadata(
        detected.type,
        detected.id,
        detected.country,
        detected.url,
        fetchImpl,
      );
    }

    if (!metadata || metadata.items.length === 0) {
      return {
        loadType: "empty",
        tracks: [],
        playlist: null,
        resolvedVia: "metadata-empty",
        note: `Could not read metadata from that ${detected.kind} link (make sure it is public, or paste the song title directly).`,
      };
    }

    // Eagerly resolve track #1 directly using healthy node sources so audio starts immediately
    const firstItem = metadata.items[0];
    let firstTrack = null;

    if (firstItem.isrc && nodeSupportsManager(nodeSources, "deezer") && !failedSources.has("deezer")) {
      try {
        const isrcRes = await player.search({ query: firstItem.isrc, source: "dzisrc" }, requester);
        if (isrcRes?.tracks?.length > 0) firstTrack = isrcRes.tracks[0];
      } catch {
        // fall through
      }
    }

    if (!firstTrack) {
      const firstSearchText = [firstItem.title, firstItem.author].filter(Boolean).join(" - ");
      const preferred =
        !failedSources.has("deezer") && nodeSupportsManager(nodeSources, "deezer")
          ? "dzsearch"
          : preferredSource;
      const firstRes = await searchWithFallback(player, firstSearchText, requester, preferred);
      firstTrack = pickBestMatch(firstRes.tracks, firstItem);
    }

    if (!firstTrack) {
      return {
        loadType: "empty",
        tracks: [],
        playlist: null,
        resolvedVia: "metadata-no-stream",
        note: `Found "${firstItem.title}" on ${detected.kind}, but no playable audio stream was found on the active music node.`,
      };
    }

    tagOriginMetadata(firstTrack, firstItem);

    // Build lazy unresolved tracks for the rest of an album/playlist
    const remainingTracks = metadata.items
      .slice(1)
      .map((item) => buildLazyFallbackTrack(player, item, requester, preferredSource));

    const out = {
      loadType: metadata.isPlaylist ? "playlist" : "track",
      tracks: [firstTrack, ...remainingTracks],
      playlist: metadata.isPlaylist
        ? {
            name: metadata.playlistName,
            title: metadata.playlistName,
            uri: metadata.playlistUrl,
            thumbnail: metadata.artworkUrl,
          }
        : null,
      resolvedVia: `${detected.kind}-fallback`,
    };
    setCachedSearch(cacheKey, out);
    return out;
  }

  return {
    loadType: "empty",
    tracks: [],
    playlist: null,
    resolvedVia: "none",
  };
}
