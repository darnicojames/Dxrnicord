import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchFallbackOrder,
  detectQueryKind,
  fetchAppleMusicMetadata,
  fetchDeezerMetadata,
  hasExplicitSourcePrefix,
  materializeDirectTrack,
  parseSpotifyEmbedHtml,
  pickBestMatch,
  resolveAlternateMirror,
  scoreTrackRelevance,
  searchAllSources,
} from "../src/services/trackResolver.js";

test("detectQueryKind classifies URLs across all major streaming platforms", () => {
  assert.deepEqual(detectQueryKind("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
    kind: "youtube",
    isUrl: true,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });

  assert.deepEqual(
    detectQueryKind("https://open.spotify.com/intl-en/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"),
    {
      kind: "spotify",
      isUrl: true,
      type: "track",
      id: "4cOdK2wGLETKBW3PvgPWqT",
      url: "https://open.spotify.com/intl-en/track/4cOdK2wGLETKBW3PvgPWqT?si=abc",
    },
  );

  assert.equal(detectQueryKind("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").type, "playlist");
  assert.equal(detectQueryKind("https://soundcloud.com/artist/track").kind, "soundcloud");
  assert.equal(detectQueryKind("https://artist.bandcamp.com/track/demo").kind, "bandcamp");
  assert.equal(detectQueryKind("https://www.twitch.tv/monstercat").kind, "twitch");
  assert.equal(detectQueryKind("https://stream.example.com/radio.mp3").kind, "http");

  const appleSong = detectQueryKind(
    "https://music.apple.com/us/album/some-album/123456789?i=987654321",
  );
  assert.equal(appleSong.kind, "applemusic");
  assert.equal(appleSong.type, "song");
  assert.equal(appleSong.id, "987654321");

  const deezer = detectQueryKind("https://www.deezer.com/en/playlist/908622995");
  assert.equal(deezer.kind, "deezer");
  assert.equal(deezer.type, "playlist");
  assert.equal(deezer.id, "908622995");

  assert.deepEqual(detectQueryKind("daft punk get lucky"), {
    kind: "search",
    isUrl: false,
    query: "daft punk get lucky",
  });
});

test("buildSearchFallbackOrder filters by active node capabilities", () => {
  const onlySoundCloud = buildSearchFallbackOrder("ytmsearch", new Set(["soundcloud", "http"]));
  assert.deepEqual(onlySoundCloud, ["scsearch"]);

  const fullNode = buildSearchFallbackOrder("ytsearch", new Set(["youtube", "soundcloud", "deezer"]));
  assert.deepEqual(fullNode, ["ytsearch", "dzsearch", "scsearch", "ytmsearch"]);

  const ytBlockedOrder = buildSearchFallbackOrder("ytmsearch", new Set(["youtube", "soundcloud", "deezer"]), true);
  assert.deepEqual(ytBlockedOrder.slice(0, 2), ["dzsearch", "scsearch"]);

  // When Deezer fails on a node (e.g. broken ARL), buildSearchFallbackOrder puts healthy sources first
  const dzBrokenOrder = buildSearchFallbackOrder(
    "dzsearch",
    new Set(["youtube", "soundcloud", "deezer"]),
    new Set(["deezer"]),
  );
  assert.equal(dzBrokenOrder[0] !== "dzsearch", true);
  assert.equal(dzBrokenOrder[dzBrokenOrder.length - 1], "dzsearch");
});

test("materializeDirectTrack resolves Spotify tracks via fast Deezer ISRC and preserves Spotify badge", async () => {
  const searched = [];
  const fakePlayer = {
    node: { info: { sourceManagers: ["youtube", "deezer", "spotify", "soundcloud"] } },
    search: async (q) => {
      searched.push(q);
      if (q.source === "dzisrc") {
        return {
          tracks: [
            {
              encoded: "base64audio",
              info: {
                title: "I Know (PR1SVX Edit)",
                author: "Kanii",
                duration: 134_000,
                sourceName: "deezer",
              },
              pluginInfo: {},
            },
          ],
        };
      }
      return { tracks: [] };
    },
  };

  const spotifyTrack = {
    info: {
      title: "I Know - PR1SVX Edit",
      author: "Kanii, PR1SVX",
      duration: 134_000,
      isrc: "USWB12300001",
      sourceName: "spotify",
      uri: "https://open.spotify.com/track/abc",
      artworkUrl: "https://i.scdn.co/art.jpg",
    },
    pluginInfo: {},
  };

  const materialized = await materializeDirectTrack(fakePlayer, spotifyTrack, { id: "1" }, "ytmsearch");
  assert.equal(searched[0].source, "dzisrc");
  assert.equal(materialized.info.sourceName, "deezer");
  assert.equal(materialized.pluginInfo.clientData.originPlatform, "spotify");
  assert.equal(materialized.pluginInfo.clientData.originTitle, "I Know - PR1SVX Edit");
});

test("resolveAlternateMirror switches away from a stalled YouTube source to Deezer/SoundCloud", async () => {
  const triedSources = [];
  const fakePlayer = {
    node: { info: { sourceManagers: ["youtube", "deezer", "soundcloud"] } },
    search: async (q) => {
      triedSources.push(q.source);
      if (q.source === "dzsearch") {
        return {
          tracks: [
            {
              encoded: "deezer-stream",
              info: { title: "Song", author: "Artist", duration: 180_000, sourceName: "deezer" },
              pluginInfo: {},
            },
          ],
        };
      }
      return { tracks: [] };
    },
  };

  const stalledYoutube = {
    info: { title: "Song", author: "Artist", duration: 180_000, sourceName: "youtube" },
    pluginInfo: {},
  };

  const mirror = await resolveAlternateMirror(fakePlayer, stalledYoutube, { id: "1" });
  assert.equal(mirror.info.sourceName, "deezer");
  assert.equal(triedSources.includes("ytsearch"), false);
  assert.equal(triedSources.includes("ytmsearch"), false);
});

test("parseSpotifyEmbedHtml extracts keyless track and playlist metadata", () => {
  const trackHtml = `
    <html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                type: "track",
                name: "Blinding Lights",
                duration: 200040,
                artists: [{ name: "The Weeknd" }],
                visualIdentity: { image: [{ url: "https://i.scdn.co/cover.jpg" }] },
              },
            },
          },
        },
      },
    })}</script></html>`;

  const parsedTrack = parseSpotifyEmbedHtml(
    trackHtml,
    "track",
    "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
  );
  assert.equal(parsedTrack.isPlaylist, false);
  assert.equal(parsedTrack.items.length, 1);
  assert.equal(parsedTrack.items[0].title, "Blinding Lights");
  assert.equal(parsedTrack.items[0].author, "The Weeknd");
  assert.equal(parsedTrack.items[0].duration, 200040);

  const playlistHtml = `
    <html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                type: "playlist",
                name: "Chill Mix",
                trackList: [
                  { title: "Track A", subtitle: "Artist A", duration: 180000, uri: "spotify:track:111" },
                  { title: "Track B", subtitle: "Artist B", duration: 210000, uri: "spotify:track:222" },
                ],
              },
            },
          },
        },
      },
    })}</script></html>`;

  const parsedPlaylist = parseSpotifyEmbedHtml(
    playlistHtml,
    "playlist",
    "https://open.spotify.com/playlist/xyz",
  );
  assert.equal(parsedPlaylist.isPlaylist, true);
  assert.equal(parsedPlaylist.playlistName, "Chill Mix");
  assert.equal(parsedPlaylist.items.length, 2);
  assert.equal(parsedPlaylist.items[1].uri, "https://open.spotify.com/track/222");
});

test("fetchDeezerMetadata and fetchAppleMusicMetadata parse public API responses", async () => {
  const deezer = await fetchDeezerMetadata(
    "track",
    "3135556",
    "https://www.deezer.com/track/3135556",
    async () => ({
      ok: true,
      json: async () => ({
        title: "Harder, Better, Faster, Stronger",
        duration: 224,
        artist: { name: "Daft Punk" },
        album: { cover_big: "https://cdn.deezer.com/art.jpg" },
      }),
    }),
  );
  assert.equal(deezer.items[0].title, "Harder, Better, Faster, Stronger");
  assert.equal(deezer.items[0].duration, 224000);

  const apple = await fetchAppleMusicMetadata(
    "song",
    "1440857786",
    "us",
    "https://music.apple.com/us/song/1440857786",
    async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            wrapperType: "track",
            trackName: "Bohemian Rhapsody",
            artistName: "Queen",
            trackTimeMillis: 354320,
            artworkUrl100: "https://is1.mzstatic.com/100x100bb.jpg",
          },
        ],
      }),
    }),
  );
  assert.equal(apple.items[0].title, "Bohemian Rhapsody");
  assert.equal(apple.items[0].artworkUrl, "https://is1.mzstatic.com/600x600bb.jpg");
});

test("pickBestMatch prefers track closest to expected duration", () => {
  const tracks = [
    { info: { title: "Song (10 Hour Loop)", duration: 36000000 } },
    { info: { title: "Song (Official Audio)", duration: 201000 } },
  ];
  const best = pickBestMatch(tracks, { duration: 200000 });
  assert.equal(best.info.title, "Song (Official Audio)");
});

test("hasExplicitSourcePrefix recognizes sp:, sc:, dz:, yt:, ytm: and ignores plain queries and URLs", () => {
  assert.equal(hasExplicitSourcePrefix("sp:blinding lights"), true);
  assert.equal(hasExplicitSourcePrefix("sc:lofi beats"), true);
  assert.equal(hasExplicitSourcePrefix("dz:get lucky"), true);
  assert.equal(hasExplicitSourcePrefix("blinding lights"), false);
  assert.equal(hasExplicitSourcePrefix("https://open.spotify.com/track/abc"), false);
});

test("scoreTrackRelevance ranks exact official artist/title above remixes and wrong artists", () => {
  const query = "Take It To The Head DJ Khaled";
  const official = {
    info: { title: "Take It To The Head", author: "DJ Khaled", duration: 264_000, sourceName: "ytmusic" },
  };
  const wrongArtist = {
    info: { title: "Take It to the Head", author: "On D.U.B Boyz", duration: 210_000, sourceName: "youtube" },
  };
  const fanRemix = {
    info: { title: "DJ Khaled - Take It To The Head Remix", author: "RandomUser", duration: 190_000, sourceName: "soundcloud" },
  };

  const sOfficial = scoreTrackRelevance(official, query);
  const sWrong = scoreTrackRelevance(wrongArtist, query);
  const sRemix = scoreTrackRelevance(fanRemix, query);
  assert.ok(sOfficial > sWrong, `official (${sOfficial}) should beat wrong artist (${sWrong})`);
  assert.ok(sOfficial > sRemix, `official (${sOfficial}) should beat unrequested remix (${sRemix})`);

  // Requesting "live" should NOT penalize live versions
  const liveTrack = {
    info: { title: "What if I miss you? (Live in the Studio)", author: "Artist", duration: 200_000, sourceName: "youtube" },
  };
  assert.ok(scoreTrackRelevance(liveTrack, "What if I miss you Live in the Studio") > 100);
});

test("searchAllSources queries YouTube, Spotify, Deezer, and SoundCloud in parallel and pairs Spotify winner with direct ISRC stream", async () => {
  const searched = [];
  const fakePlayer = {
    node: { options: { id: "multi-test" }, info: { sourceManagers: ["youtube", "spotify", "deezer", "soundcloud"] } },
    search: async ({ source }) => {
      searched.push(source);
      if (source === "ytmsearch") {
        return {
          loadType: "search",
          tracks: [
            { encoded: "yt-wrong", info: { title: "Take It to the Head", author: "On D.U.B Boyz", duration: 210_000, sourceName: "youtube", identifier: "yt1" }, pluginInfo: {} },
          ],
        };
      }
      if (source === "spsearch") {
        return {
          loadType: "search",
          tracks: [
            { encoded: "sp-exact", info: { title: "Take It To The Head", author: "DJ Khaled", duration: 264_000, isrc: "USCM51200323", sourceName: "spotify", identifier: "sp1", uri: "https://open.spotify.com/track/sp1" }, pluginInfo: {} },
          ],
        };
      }
      if (source === "dzsearch") {
        return {
          loadType: "search",
          tracks: [
            { encoded: "dz-exact", info: { title: "Take It To The Head (Explicit Version)", author: "DJ Khaled", duration: 264_000, isrc: "USCM51200323", sourceName: "deezer", identifier: "dz1" }, pluginInfo: {} },
          ],
        };
      }
      if (source === "scsearch") {
        return {
          loadType: "search",
          tracks: [
            { encoded: "sc-remix", info: { title: "Take It To The Head Remix", author: "Prynce Suave", duration: 190_000, sourceName: "soundcloud", identifier: "sc1" }, pluginInfo: {} },
          ],
        };
      }
      return { loadType: "empty", tracks: [] };
    },
  };

  const result = await searchAllSources(fakePlayer, "Take It To The Head DJ Khaled", { id: "u1" }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ title: "Take It To The Head (Explicit Version)", artist: { name: "DJ Khaled" }, explicit_lyrics: true }],
      }),
    }),
  });
  assert.deepEqual([...searched].sort(), ["dzsearch", "scsearch", "spsearch", "ytmsearch"]);
  assert.equal(result.respondedSources.length, 4);
  assert.equal(result.rankedTracks.length, 4);
  assert.equal(result.isExplicit, true);
  // Best track must be DJ Khaled on non-YouTube direct stream
  assert.equal(result.bestTrack.info.author, "DJ Khaled");
  assert.equal(result.bestTrack.encoded, "dz-exact");
});

test("searchAllSources routes explicit songs to non-YouTube and non-explicit songs to YouTube (with alt fallback when YouTube misses)", async () => {
  const makePlayer = ({ ytTrack, dzTrack }) => ({
    node: { options: { id: "explicit-routing-test" }, info: { sourceManagers: ["youtube", "spotify", "deezer", "soundcloud"] } },
    search: async ({ source }) => {
      if (source === "ytmsearch") return { loadType: ytTrack ? "search" : "empty", tracks: ytTrack ? [ytTrack] : [] };
      if (source === "dzsearch") return { loadType: dzTrack ? "search" : "empty", tracks: dzTrack ? [dzTrack] : [] };
      return { loadType: "empty", tracks: [] };
    },
  });

  // 1. Explicit song (even when YouTube also matches cleanly!) -> prefers Deezer (non-YouTube)
  const explicitPlayer = makePlayer({
    ytTrack: { encoded: "yt-nlu", info: { title: "Not Like Us", author: "Kendrick Lamar", duration: 274_000, sourceName: "ytmusic", identifier: "yt1" }, pluginInfo: {} },
    dzTrack: { encoded: "dz-nlu", info: { title: "Not Like Us", author: "Kendrick Lamar", duration: 274_000, sourceName: "deezer", identifier: "dz1" }, pluginInfo: {} },
  });
  const explicitRes = await searchAllSources(explicitPlayer, "Not Like Us Kendrick Lamar", { id: "u1" }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ title: "Not Like Us", artist: { name: "Kendrick Lamar" }, explicit_lyrics: true }],
      }),
    }),
  });
  assert.equal(explicitRes.isExplicit, true);
  assert.equal(explicitRes.bestTrack.encoded, "dz-nlu");

  // 2. Non-explicit song when YouTube matches cleanly -> prefers YouTube
  const cleanPlayer = makePlayer({
    ytTrack: { encoded: "yt-bagyo", info: { title: "ako ang bagyo", author: "SHEAN", duration: 274_000, sourceName: "ytmusic", identifier: "yt2" }, pluginInfo: {} },
    dzTrack: { encoded: "dz-bagyo", info: { title: "ako ang bagyo", author: "Shean", duration: 274_000, sourceName: "deezer", identifier: "dz2" }, pluginInfo: {} },
  });
  const cleanRes = await searchAllSources(cleanPlayer, "ako ang bagyo shean", { id: "u1" }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ title: "ako ang bagyo", artist: { name: "Shean" }, explicit_lyrics: false }],
      }),
    }),
  });
  assert.equal(cleanRes.isExplicit, false);
  assert.equal(cleanRes.bestTrack.encoded, "yt-bagyo");

  // 3. Non-explicit song when YouTube cannot find it -> falls back to Deezer/alternative source
  const ytMissPlayer = makePlayer({
    ytTrack: null,
    dzTrack: { encoded: "dz-blinding", info: { title: "Blinding Lights", author: "The Weeknd", duration: 200_000, sourceName: "deezer", identifier: "dz3" }, pluginInfo: {} },
  });
  const missRes = await searchAllSources(ytMissPlayer, "Blinding Lights The Weeknd", { id: "u1" }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ title: "Blinding Lights", artist: { name: "The Weeknd" }, explicit_lyrics: false }],
      }),
    }),
  });
  assert.equal(missRes.isExplicit, false);
  assert.equal(missRes.bestTrack.encoded, "dz-blinding");

  // 4. SoundCloud Go+ 30s preview snip penalized below full track
  const fullSc = { info: { title: "Blinding Lights", author: "The Weeknd", duration: 200_000, sourceName: "soundcloud" }, pluginInfo: { policy: "ALLOW", playback: "FULL" } };
  const snipSc = { info: { title: "Blinding Lights", author: "The Weeknd", duration: 200_000, sourceName: "soundcloud" }, pluginInfo: { policy: "SNIP", playback: "PARTIAL" } };
  assert.ok(scoreTrackRelevance(fullSc, "Blinding Lights The Weeknd") > scoreTrackRelevance(snipSc, "Blinding Lights The Weeknd") + 50);
});

test("searchAllSources soft cap cuts off hanging sources immediately once fast sources respond, and rescues slower nodes", async () => {
  // Fast source finishes in 5ms while another hangs for 2000ms -> returns right at soft cap (~40ms)
  const mixedPlayer = {
    node: { options: { id: "softcap-test" }, info: { sourceManagers: ["youtube", "deezer"] } },
    search: async ({ source }) => {
      if (source === "ytmsearch") {
        return {
          loadType: "search",
          tracks: [{ encoded: "yt-fast", info: { title: "luther", author: "Kendrick Lamar", duration: 177_000, sourceName: "ytmusic", identifier: "y1" }, pluginInfo: {} }],
        };
      }
      await new Promise((r) => {
        const t = setTimeout(r, 2000);
        t.unref?.();
      });
      return { loadType: "empty", tracks: [] };
    },
  };

  const t0 = Date.now();
  const res = await searchAllSources(mixedPlayer, "luther kendrick", { id: "u1" }, {
    timeoutMs: 40,
    hardTimeoutMs: 500,
    fetchImpl: async () => ({ ok: false }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.bestTrack.encoded, "yt-fast");
  assert.ok(elapsed < 250, `Expected soft cap cut-off (<250ms), got ${elapsed}ms`);

  // If 0 sources finish by soft cap (30ms) but one finishes at 70ms -> rescues cleanly instead of returning empty!
  const slowPlayer = {
    node: { options: { id: "rescue-test" }, info: { sourceManagers: ["youtube"] } },
    search: async () => {
      await new Promise((r) => {
        const t = setTimeout(r, 65);
        t.unref?.();
      });
      return {
        loadType: "search",
        tracks: [{ encoded: "yt-rescued", info: { title: "luther", author: "Kendrick Lamar", duration: 177_000, sourceName: "ytmusic", identifier: "y2" }, pluginInfo: {} }],
      };
    },
  };
  const rescued = await searchAllSources(slowPlayer, "luther kendrick", { id: "u1" }, {
    timeoutMs: 25,
    hardTimeoutMs: 400,
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal(rescued.bestTrack.encoded, "yt-rescued");
});
