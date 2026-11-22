# Dxrnicord — Discord Music Bot

An ultra-lightweight, security-hardened Discord music bot built with **Node.js (ESM)**, **`discord.js` v14**, and **`lavalink-client` v2** using **prefix-only `d!` commands** and interactive playback controls.

Designed to run **24/7 for $0** (~60–90 MB RAM, only 3 runtime dependencies, zero local FFmpeg/yt-dlp overhead) while delivering fast, reliable streaming across **YouTube, YouTube Music, Spotify, Deezer, SoundCloud, Apple Music, Bandcamp, Twitch, Vimeo, and 24/7 live internet radio**.

---

## Key Features

- **4-Source Parallel Search (`d!play` & `d!search`):** Queries **YouTube Music, Spotify, Deezer, and SoundCloud simultaneously** (~1.1s total) and ranks results by title + artist relevance, filtering out unrequested fan remixes, karaoke, covers, and 1-hour loops. Spotify winners automatically pair with a direct audio stream (by ISRC or title/artist match) for instant playback.
- **NodeLink v3 + Lavalink v4.2+ (DAVE E2EE) Auto-Discovery:** Automatically discovers and ranks up to **5 independent DAVE-compatible public audio servers** by warm ping, CPU load, frame health, and full audio filter support.
- **Self-Healing Playback & Cross-Node Failover:** Remembers failing sources per node (`deezer`, `youtube`, `soundcloud`), skips broken sources on future searches, automatically migrates unhealthy sessions to a healthy backup server without losing queued tracks, resumes mid-song stalls at the exact timestamp, and finishes cleanly on EOF stalls.
- **Instant 15-Band Equalizer & 11 Audio Filters:** Studio-tuned EQ presets (`bassboost`, `superbass`, `trebleboost`, `vocal`, `pop`, `rock`, `electronic`, `classical`, `soft`, `lofi`), custom 3-band EQ, quick bass/treble sliders, independent speed & pitch controls, and 11 audio effects — applied in **one atomic REST PATCH with buffer flush** (~0.3–0.5s audible response).
- **Continuous 24/7 Live Radio (`d!radio`):** 13 verified 24/7 HTTPS stations (Lo-Fi, Chillhop, Synthwave, Anime/J-Pop, Hip-Hop, EDM, Indie, Rock, Jazz, Classical, Ambient) + **40,000+ searchable worldwide stations** via Radio Browser + custom stream URLs + automatic reconnect watchdog.
- **Session Host & Democratic Vote-Skip:** The first user who summons the bot (`d!join` or `d!play`) becomes the **Session Host** and gets instant skip privileges alongside the current track requester and admins; other listeners in the voice channel agree to skip via majority vote (`d!skip` or Skip button).
- **Custom Server & App Styling:** Per-server default volume, EQ, search source, embed theme color, vote-skip toggle (`d!settings`), automatic Discord Developer Portal **App Emojis** (`d!emojis`), clean emoji-free bot server-count presence, and live Voice Channel Status updates.

---

## Commands (`d!` prefix only)

> Tip: Force a specific search platform anytime with `yt:`, `ytm:`, `sp:`, `dz:`, or `sc:` (for example, `d!play sc:lofi beats` or `d!search sp:blinding lights`).

### Playback

| Command | Aliases | Description |
| --- | --- | --- |
| `d!join` | `d!j`, `d!connect`, `d!summon` | Join your voice channel, claim Session Host, and pre-warm the voice + DAVE tunnel |
| `d!play <query or URL>` | `d!p` | Parallel 4-source search (YouTube, Spotify, Deezer, SoundCloud) or play any platform/radio URL |
| `d!search <query>` | `d!find` | Interactive dropdown showing up to 8 ranked matches across YouTube, Spotify, Deezer & SoundCloud |
| `d!pause` | `d!resume` | Pause or resume playback |
| `d!skip [pos]` | `d!s`, `d!next` | Instant skip (Session Host / requester / Admin) or majority vote-skip; optional queue jump |
| `d!stop` | `d!dc`, `d!disconnect`, `d!leave` | Stop playback, clear queue, and disconnect |

### Queue & Info

| Command | Aliases | Description |
| --- | --- | --- |
| `d!queue [page]` | `d!q` | View the paginated music queue |
| `d!nowplaying` | `d!np` | Live progress bar, active EQ/filter summary, and interactive control buttons |
| `d!volume [1-150]` | `d!vol`, `d!v` | View or change playback volume |
| `d!loop [off\|track\|queue]` | `d!repeat` | Set or cycle repeat mode |
| `d!shuffle` | `d!shuf` | Shuffle upcoming tracks |
| `d!seek <time>` | — | Jump to a timestamp (`90`, `1:30`, `1:02:03`) |
| `d!remove <pos>` | `d!rm` | Remove a specific track from the queue |
| `d!clear` | `d!clr` | Clear all upcoming tracks |
| `d!lyrics [song]` | `d!ly` | Fetch song lyrics via keyless LRCLIB |
| `d!help` | `d!h`, `d!commands` | Show the interactive command guide |

### Equalizer & Audio Customization

| Command | Aliases | Description |
| --- | --- | --- |
| `d!eq [preset \| custom <b m t>]` | `d!equalizer` | Live 3-zone EQ bar, interactive preset dropdown, or custom Bass/Mid/Treble (`-5` to `+10`) |
| `d!bassboost [0-10]` | `d!bb`, `d!bass` | Quick bass boost slider (`0` resets to flat) |
| `d!treble [0-10]` | `d!tb`, `d!trebleboost` | Quick treble boost slider (`0` resets to flat) |
| `d!filter [preset]` | `d!fx`, `d!effect` | Interactive effect picker: `nightcore`, `daycore`/`slowed`, `vaporwave`, `8d`, `lofi`, `karaoke`, `vibrato`, `tremolo`, `chipmunk`, `deep`, `off` |
| `d!speed <0.5-2.0>` | — | Adjust playback tempo independently |
| `d!pitch <0.5-2.0>` | — | Adjust vocal/instrument pitch independently |
| `d!resetfx` | `d!reset` | Reset all active EQ, filters, speed, and pitch instantly |

### 24/7 Radio, Modes & Admin Controls

| Command | Aliases | Description |
| --- | --- | --- |
| `d!radio [station \| search <q> \| URL \| list \| off]` | `d!rad`, `d!fm`, `d!station` | Continuous 24/7 live radio with station menu, 40,000+ station search & auto-reconnect |
| `d!autoplay [on\|off]` | `d!ap` | Automatically queue related tracks when the queue ends |
| `d!247 [on\|off]` | `d!stay`, `d!alwayson` | Keep the bot in the voice channel when idle |
| `d!settings [volume\|eq\|source\|color\|voteskip\|reset]` | `d!config` | **[Admin Role]** Customize per-server defaults |
| `d!nodes [switch]` | — | **[Admin Role]** Inspect audio servers (ping, DAVE, frame health) or live-migrate playback |
| `d!emojis [refresh]` | `d!emoji` | **[Admin Role]** View or reload custom Discord Developer Portal App Emojis |
| `d!security` | `d!sec` | **[Admin Role]** Live security posture report |

---

## Architecture & Project Structure

```text
discord-music-bot/
├── index.js                      # Root shim importing ./src/index.js (for hosts expecting index.js)
├── package.json                  # Node.js ESM, 3 runtime deps (discord.js, lavalink-client, dotenv)
├── .env.example                  # Documented environment variable template
├── Dockerfile & docker-compose.yml # Optional self-hosted bot + Lavalink v4.2+ stack
├── lavalink/application.yml      # Lavalink v4.2+ config (youtube-plugin + lavasrc-plugin)
├── src/
│   ├── index.js                  # Bot bootstrap, LavalinkManager, presence, raw voice relay, recovery loop
│   ├── config.js                 # Typed env parser with clamping & defaults
│   ├── deploy-commands.js        # Clears legacy slash commands on startup
│   ├── commands/                 # Prefix d! command modules (play, search, controls, queue, filter, radio, extras, nodes, help)
│   ├── events/                   # messageHandler, interactionHandler (buttons), lavalinkEvents (failover & lifecycle)
│   ├── security/guard.js         # SSRF/IP validator, RateLimiter, strict Admin role access control, secret redaction
│   ├── services/
│   │   ├── nodeDiscovery.js      # Public Lavalink v4.2+ & NodeLink v3+ discovery, scoring, failed-source memory
│   │   ├── trackResolver.js      # 4-source parallel search, relevance ranker, Spotify/Deezer/Apple/YT keyless rescue
│   │   ├── audioPresets.js       # 15-band EQ presets, filter presets, atomic single-PATCH buffer flush
│   │   ├── radio.js              # 13 verified 24/7 radio stations + Radio Browser search + stream failover
│   │   ├── voteSkip.js           # Session Host & majority vote-skip engine
│   │   ├── autoplay.js           # Deduplicated related-track autoplay
│   │   ├── lyrics.js             # Keyless LRCLIB lyrics lookup & title cleaner
│   │   ├── guildSettings.js      # Per-guild customization state store
│   │   ├── voiceStatus.js        # Clean emoji-free presence & VC status helpers
│   │   └── healthServer.js       # Optional HTTP /health endpoint
│   ├── ui/                       # Embeds, interactive buttons, custom App Emoji loader
│   └── utils/                    # VoiceReadinessTracker (DAVE handshake), smoothPlay pre-buffer, voiceChecks
└── test/                         # 58 unit tests using Node's built-in node:test runner
```

---

## Built-in Security Protections

- **Prefix-Only Mode (`d!`):** Automatically clears legacy slash commands on boot (`CLEAR_SLASH_COMMANDS=true`) and ignores slash interactions.
- **Strict Admin Customization Lock:** Admin commands (`d!settings`, `d!nodes`, `d!security`, `d!emojis`) strictly require at least one **server role** carrying `Administrator` or `Manage Server` (`ManageGuild`) permission.
- **Mention Injection Guard:** `allowedMentions: { parse: [] }` globally blocks crafted song titles from pinging `@everyone`, `@here`, or roles.
- **SSRF & Unsafe URL Blocking:** Rejects `localhost`, RFC1918 private IPs (`10.x`, `172.16-31.x`, `192.168.x`), loopback, IPv6 private/link-local, cloud metadata (`169.254.169.254`), obfuscated octal/hex/decimal/shorthand IPs, non-HTTP(S) schemes, embedded credentials, and short-link redirects to private networks.
- **Anti-Spam Rate Limiter & Queue Cap:** Per-user cooldown (`2s`), burst cap (`8 cmds / 15s`), and queue limit (`200` tracks max) protect lightweight containers from DoS/OOM abuse.
- **Optional Lockdown via `.env`:** Server allowlist (`ALLOWED_GUILD_IDS` with auto-leave), channel allowlist (`ALLOWED_CHANNEL_IDS`), user allowlist (`ALLOWED_USER_IDS`), and DJ role lock (`REQUIRE_DJ_ROLE=true`).
- **Secret Redaction:** Automatically strips `DISCORD_TOKEN` and sensitive credentials from error output and logs.

---

## Setup & Local Development

### 1. Discord Developer Portal Checklist

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → your application → **Bot**.
2. Turn **ON** **Message Content Intent** under **Privileged Gateway Intents** → **Save Changes** *(required for `d!` prefix commands)*.
3. Under **OAuth2**, ensure **Requires OAuth2 Code Grant** is **OFF**.
4. *(Recommended)* Turn **OFF** **Public Bot** if you only want to run the bot in your own server(s).
5. *(Optional)* Upload custom PNG/GIF icons under **Emojis** matching slot names from `d!emojis` to customize buttons and embeds.

### 2. Run Locally

```bash
npm install
cp .env.example .env
# Edit .env and set DISCORD_TOKEN=your_token_here
npm start
```

### 3. Run the Test Suite

```bash
npm test
```

All **58 unit tests** cover config parsing, command registration, SSRF/access security, 4-source search relevance & Spotify ISRC pairing, node discovery/DAVE compatibility/failover scoring, 15-band EQ & instant filter flush, smooth pre-buffer cancellation, 24/7 radio validation, embeds/emojis, and Session Host vote-skip logic.

---

## Deployment Options

### Option A: Zero-Cost Hosting on Wispbyte (Node.js)

1. Create a free Node.js server on Wispbyte and add `DISCORD_TOKEN=...` to `.env` (no Lavalink setup needed — public NodeLink v3 / Lavalink v4.2+ auto-discovery works out of the box).
2. Upload the project files (excluding `node_modules/` and `.env`) in the **Files** tab.
3. Click **Start** / **Restart** in **Console**.

### Option B: Self-Hosted Bot + Private Lavalink (Docker Compose)

```bash
cp .env.example .env
# Set DISCORD_TOKEN, LAVALINK_HOST=lavalink, LAVALINK_PORT=2333, LAVALINK_PASSWORD=youshallnotpass, AUTO_PUBLIC_NODES=false
docker compose up -d
```

---

## License

MIT
