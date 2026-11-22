import assert from "node:assert/strict";
import test from "node:test";
import { validateExternalUrl } from "../src/security/guard.js";
import {
  RADIO_STATIONS,
  resolveCuratedStation,
  searchRadioStations,
  tuneRadioStream,
} from "../src/services/radio.js";

test("all curated 24/7 radio stations pass SSRF validation and alias resolution", () => {
  const keys = Object.keys(RADIO_STATIONS);
  assert.ok(keys.length >= 10);

  for (const station of Object.values(RADIO_STATIONS)) {
    assert.equal(validateExternalUrl(station.url).ok, true, `Invalid URL on ${station.key}`);
    for (const backup of station.backupUrls || []) {
      assert.equal(validateExternalUrl(backup).ok, true, `Invalid backup URL on ${station.key}`);
    }
  }

  assert.equal(resolveCuratedStation("lofi").key, "lofi");
  assert.equal(resolveCuratedStation("study").key, "lofi");
  assert.equal(resolveCuratedStation("edm").key, "dance");
  assert.equal(resolveCuratedStation("jpop").key, "anime");
  assert.equal(resolveCuratedStation("kpop").key, "kpop");
  assert.equal(resolveCuratedStation("unknown_station_xyz"), null);
});

test("searchRadioStations filters out internal/SSRF URLs and keeps safe audio streams", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => [
      {
        stationuuid: "bad-ssrf",
        name: "Evil Localhost Stream",
        url_resolved: "http://127.0.0.1:8000/stream.mp3",
        codec: "MP3",
        bitrate: 128,
      },
      {
        stationuuid: "good-1",
        name: "Chill Lofi Radio",
        url_resolved: "https://stream.example.com/lofi.mp3",
        codec: "MP3",
        bitrate: 192,
        countrycode: "US",
        favicon: "https://stream.example.com/icon.png",
      },
    ],
  });

  const results = await searchRadioStations("lofi", { fetchImpl: mockFetch, limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "Chill Lofi Radio");
  assert.equal(results[0].url, "https://stream.example.com/lofi.mp3");
});

test("tuneRadioStream falls back to backupUrls and tags isRadio metadata", async () => {
  const triedUrls = [];
  let playedTrack = null;

  const fakePlayer = {
    queue: { tracks: [], splice: async () => {} },
    search: async ({ query }) => {
      triedUrls.push(query);
      if (query.includes("primary")) {
        return { loadType: "error", tracks: [] };
      }
      return {
        loadType: "track",
        tracks: [{ encoded: "radio-audio", info: { title: "Stream", isStream: true }, pluginInfo: {} }],
      };
    },
    play: async ({ clientTrack }) => {
      playedTrack = clientTrack;
    },
  };

  const station = {
    key: "lofi",
    name: "Lo-Fi Beats 24/7",
    genre: "Lo-Fi / Study",
    url: "https://primary.example.com/lofi.mp3",
    backupUrls: ["https://backup.example.com/lofi.mp3"],
  };

  const res = await tuneRadioStream(fakePlayer, station, { id: "1", username: "tester" });
  assert.equal(res.ok, true);
  assert.equal(triedUrls.length, 2);
  assert.equal(playedTrack.pluginInfo.clientData.isRadio, true);
  assert.equal(playedTrack.pluginInfo.clientData.originTitle, "Lo-Fi Beats 24/7");
});
