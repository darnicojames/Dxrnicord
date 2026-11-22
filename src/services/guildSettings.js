/**
 * Lightweight in-memory per-guild playback & customization preferences:
 * - autoplay, stay247
 * - defaultVolume, defaultEq, defaultSource, themeColor
 */
export class GuildSettingsStore {
  constructor() {
    /**
     * @type {Map<string, {
     *   autoplay: boolean,
     *   stay247: boolean,
     *   defaultVolume: number | null,
     *   defaultEq: string | null,
     *   defaultSource: string | null,
     *   themeColor: number | null,
     *   themeColorLabel: string | null,
     * }>}
     */
    this.map = new Map();
  }

  get(guildId) {
    return (
      this.map.get(guildId) || {
        autoplay: false,
        stay247: false,
        voteSkip: true,
        radioStation: null,
        defaultVolume: null,
        defaultEq: null,
        defaultSource: null,
        themeColor: null,
        themeColorLabel: null,
      }
    );
  }

  update(guildId, patch) {
    const next = { ...this.get(guildId), ...patch };
    this.map.set(guildId, next);
    return next;
  }

  isAutoplay(guildId) {
    return this.get(guildId).autoplay;
  }

  isStay247(guildId) {
    return this.get(guildId).stay247;
  }

  setAutoplay(guildId, enabled) {
    return this.update(guildId, { autoplay: Boolean(enabled) });
  }

  setStay247(guildId, enabled) {
    return this.update(guildId, { stay247: Boolean(enabled) });
  }

  isVoteSkip(guildId) {
    return this.get(guildId).voteSkip !== false;
  }

  setVoteSkip(guildId, enabled) {
    return this.update(guildId, { voteSkip: Boolean(enabled) });
  }

  getRadioStation(guildId) {
    return this.get(guildId).radioStation || null;
  }

  setRadioStation(guildId, station) {
    return this.update(guildId, { radioStation: station || null });
  }

  setDefaultVolume(guildId, volume) {
    return this.update(guildId, { defaultVolume: volume });
  }

  setDefaultEq(guildId, eqKey) {
    return this.update(guildId, { defaultEq: eqKey || null });
  }

  setDefaultSource(guildId, source) {
    return this.update(guildId, { defaultSource: source || null });
  }

  setThemeColor(guildId, color, label = null) {
    return this.update(guildId, { themeColor: color, themeColorLabel: label });
  }
}
