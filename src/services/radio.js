import { validateExternalUrl } from "../security/guard.js";

const RADIO_BROWSER_MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
  "https://fr1.api.radio-browser.info",
];

/**
 * Curated 24/7 live HTTPS radio stations verified directly against Lavalink v4.2+.
 * Includes backup URLs where available for uninterrupted 24/7 streaming.
 */
export const RADIO_STATIONS = {
  lofi: {
    key: "lofi",
    name: "Lo-Fi Beats 24/7",
    genre: "Lo-Fi / Study / Chillhop",
    url: "https://play.streamafrica.net/lofiradio",
    backupUrls: ["https://streams.ilovemusic.de/iloveradio17.mp3"],
  },
  chill: {
    key: "chill",
    name: "Radio Paradise Mellow Mix",
    genre: "Mellow / Chill / Acoustic",
    url: "https://stream.radioparadise.com/mellow-192",
    backupUrls: ["https://stream.radioparadise.com/mp3-192"],
  },
  pop: {
    key: "pop",
    name: "I Love Radio — Top Pop Hits",
    genre: "Pop / Charts",
    url: "https://streams.ilovemusic.de/iloveradio1.mp3",
    backupUrls: ["https://streams.ilovemusic.de/iloveradio5.mp3"],
  },
  dance: {
    key: "dance",
    name: "I Love 2 Dance",
    genre: "EDM / Dance / Club",
    url: "https://streams.ilovemusic.de/iloveradio2.mp3",
    backupUrls: [],
  },
  hiphop: {
    key: "hiphop",
    name: "I Love Hip-Hop",
    genre: "Hip-Hop / Rap / R&B",
    url: "https://streams.ilovemusic.de/iloveradio3.mp3",
    backupUrls: [],
  },
  mashup: {
    key: "mashup",
    name: "I Love Mashup",
    genre: "Mashups / Remixes / Party",
    url: "https://streams.ilovemusic.de/iloveradio5.mp3",
    backupUrls: [],
  },
  workout: {
    key: "workout",
    name: "I Love Workout",
    genre: "Gym / High Energy",
    url: "https://streams.ilovemusic.de/iloveradio23.mp3",
    backupUrls: [],
  },
  rock: {
    key: "rock",
    name: "Radio Paradise Rock Mix",
    genre: "Rock / Indie / Classic Rock",
    url: "https://stream.radioparadise.com/rock-192",
    backupUrls: ["https://stream.radioparadise.com/mp3-192"],
  },
  eclectic: {
    key: "eclectic",
    name: "Radio Paradise Main Mix",
    genre: "Eclectic / Alt / Discovery",
    url: "https://stream.radioparadise.com/mp3-192",
    backupUrls: [],
  },
  world: {
    key: "world",
    name: "Radio Paradise Global Mix",
    genre: "World / Global / Chill",
    url: "https://stream.radioparadise.com/world-etc-192",
    backupUrls: [],
  },
  anime: {
    key: "anime",
    name: "LISTEN.moe — Anime & J-Pop",
    genre: "Anime / J-Pop",
    url: "https://listen.moe/fallback",
    backupUrls: [],
  },
  kpop: {
    key: "kpop",
    name: "LISTEN.moe — K-Pop",
    genre: "K-Pop",
    url: "https://listen.moe/kpop/fallback",
    backupUrls: [],
  },
  jazz: {
    key: "jazz",
    name: "WALM Classic Jazz & Standards",
    genre: "Classic Jazz / Lounge",
    url: "https://icecast.walmradio.com:8443/classic",
    backupUrls: [],
  },
};

export const RADIO_ALIASES = {
  chillhop: "lofi",
  study: "lofi",
  beats: "lofi",
  mellow: "chill",
  ambient: "chill",
  hits: "pop",
  charts: "pop",
  edm: "dance",
  club: "dance",
  rap: "hiphop",
  rnb: "hiphop",
  remix: "mashup",
  party: "mashup",
  gym: "workout",
  indie: "rock",
  global: "world",
  jpop: "anime",
  classic: "jazz",
  lounge: "jazz",
};

/**
 * Resolve a built-in curated radio station key or alias.
 * @param {string} raw
 */
export function resolveCuratedStation(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return null;
  if (RADIO_STATIONS[key]) return RADIO_STATIONS[key];
  const mapped = RADIO_ALIASES[key];
  return mapped ? RADIO_STATIONS[mapped] : null;
}

/**
 * Search 40,000+ free live worldwide internet radio stations via Radio Browser API.
 * Strictly validates every returned stream URL through the SSRF guard.
 *
 * @param {string} query
 * @param {{ fetchImpl?: typeof fetch, limit?: number }} [opts]
 */
export async function searchRadioStations(query, { fetchImpl = fetch, limit = 5 } = {}) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return [];

  const encoded = encodeURIComponent(cleaned);

  for (const base of RADIO_BROWSER_MIRRORS) {
    try {
      // Search by name first, then tag if needed
      const urls = [
        `${base}/json/stations/search?name=${encoded}&limit=15&hidebroken=true&order=clickcount&reverse=true`,
        `${base}/json/stations/search?tag=${encoded}&limit=15&hidebroken=true&order=clickcount&reverse=true`,
      ];

      const collected = [];
      const seenUrls = new Set();

      for (const endpoint of urls) {
        const res = await fetchImpl(endpoint, {
          headers: { Accept: "application/json", "User-Agent": "DxrnicordMusicBot/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) continue;

        const list = await res.json();
        if (!Array.isArray(list)) continue;

        for (const item of list) {
          const streamUrl = String(item?.url_resolved || item?.url || "").trim();
          if (!streamUrl || seenUrls.has(streamUrl)) continue;
          if (!validateExternalUrl(streamUrl).ok) continue;
          // Prefer common audio formats Lavalink handles cleanly
          const codec = String(item?.codec || "").toUpperCase();
          if (codec && !["MP3", "AAC", "AAC+", "OGG", "OPUS", "FLAC", "UNKNOWN"].includes(codec)) {
            continue;
          }

          seenUrls.add(streamUrl);
          collected.push({
            key: `rb:${item.stationuuid || collected.length}`,
            name: String(item.name || "Live Radio").replace(/\s+/g, " ").trim().slice(0, 80),
            genre:
              [item.countrycode, codec || null, item.bitrate ? `${item.bitrate}kbps` : null]
                .filter(Boolean)
                .join(" • ") || "Live Internet Radio",
            url: streamUrl,
            backupUrls: [],
            favicon: item.favicon && validateExternalUrl(item.favicon).ok ? item.favicon : null,
          });

          if (collected.length >= limit) break;
        }
        if (collected.length >= limit) break;
      }

      if (collected.length > 0) return collected;
    } catch {
      // Try next Radio Browser mirror
    }
  }

  return [];
}

/**
 * Load and immediately play a live radio station on a Lavalink player,
 * falling back to backupUrls if the primary stream fails to load.
 */
export async function tuneRadioStream(player, station, requester) {
  const urlsToTry = [station.url, ...(station.backupUrls || [])].filter(Boolean);
  let lastError = null;

  for (const url of urlsToTry) {
    const urlCheck = validateExternalUrl(url);
    if (!urlCheck.ok) continue;

    try {
      const res = await player.search({ query: url }, requester);
      if (res && res.loadType !== "empty" && res.loadType !== "error" && res.tracks?.length > 0) {
        const track = res.tracks[0];
        track.pluginInfo = {
          ...(track.pluginInfo || {}),
          clientData: {
            ...(track.pluginInfo?.clientData || {}),
            originPlatform: "http",
            originTitle: station.name,
            originAuthor: station.genre || "24/7 Live Radio",
            originUrl: url,
            originArtworkUrl: station.favicon || null,
            isRadio: true,
            radioStationKey: station.key,
          },
        };

        // Clear any old tracks in queue so radio streams cleanly
        if (player.queue.tracks.length > 0) {
          await player.queue.splice(0, player.queue.tracks.length).catch(() => {});
        }

        await player.play({ clientTrack: track, noReplace: false });
        return { ok: true, track, url };
      }
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    error: lastError?.message || `Could not tune into "${station.name}" on the active audio node.`,
  };
}
