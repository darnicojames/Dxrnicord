/**
 * Free, zero-API-key song lyrics lookup powered by LRCLIB (https://lrclib.net).
 */

const LRCLIB_TIMEOUT_MS = 8000;

/**
 * Clean common YouTube/streaming video suffixes from track titles to improve lyrics match accuracy.
 * @param {string} rawTitle
 */
export function cleanTrackTitle(rawTitle) {
  return String(rawTitle || "")
    .replace(
      /\s*[\(\[](?:official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?\s*video|visualizer)|lyrics?|audio|hd|4k|hq|mv|remastered(?:\s*\d{4})?|explicit|clean|live(?:\s+(?:at|in|from)\s+[^\)\]]+)?)[\)\]]/gi,
      "",
    )
    .replace(/\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\s+[^\)\]]+[\)\]]/gi, "")
    .replace(/\s+(?:ft\.?|feat\.?|featuring)\s+[^-\(\[\n]+/gi, "")
    .replace(/\s*\|\s*.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip all parenthetical/bracketed suffixes (e.g. `(Live in the Studio)`, `[Sped Up]`)
 * for broader fallback matching on Deezer/SoundCloud when an exact live upload is unavailable.
 * @param {string} rawTitle
 */
export function stripParentheticals(rawTitle) {
  return cleanTrackTitle(rawTitle)
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clean artist names (e.g. strip YouTube "- Topic" suffix).
 * @param {string} rawAuthor
 */
export function cleanArtistName(rawAuthor) {
  return String(rawAuthor || "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch plain lyrics from LRCLIB for either a playing track or a manual query.
 *
 * @param {{ title?: string, author?: string, query?: string, fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ title: string, artist: string, album: string | null, lyrics: string } | null>}
 */
export async function fetchLyrics({ title, author, query, fetchImpl = fetch }) {
  const candidates = [];

  if (query) {
    candidates.push(`https://lrclib.net/api/search?q=${encodeURIComponent(query.trim())}`);
  } else {
    const cleanedTitle = cleanTrackTitle(title);
    const cleanedAuthor = cleanArtistName(author);

    if (cleanedTitle && cleanedAuthor) {
      candidates.push(
        `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(cleanedAuthor)}`,
      );
      candidates.push(
        `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanedAuthor} ${cleanedTitle}`)}`,
      );
    }
    if (cleanedTitle) {
      candidates.push(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanedTitle)}`);
    }
  }

  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "DxrnicordMusicBot/1.0",
        },
        signal: AbortSignal.timeout(LRCLIB_TIMEOUT_MS),
      });
      if (!res.ok) continue;

      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) continue;

      const hit = list.find((item) => item?.plainLyrics && item.plainLyrics.trim().length > 0);
      if (hit) {
        return {
          title: hit.trackName || title || query || "Unknown Title",
          artist: hit.artistName || author || "Unknown Artist",
          album: hit.albumName || null,
          lyrics: hit.plainLyrics.trim(),
        };
      }
    } catch {
      // Try next query variant
    }
  }

  return null;
}

/**
 * Split long lyrics cleanly on line boundaries so each chunk fits inside a Discord embed description.
 * @param {string} lyrics
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export function chunkLyrics(lyrics, maxLen = 3800) {
  const lines = String(lyrics || "").split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      current = line.slice(0, maxLen);
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
