import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { loadConfig } from "../src/config.js";
import {
  RateLimiter,
  checkAccess,
  isBlockedHost,
  redactSecrets,
  validateExternalUrl,
  validatePlayInput,
} from "../src/security/guard.js";
import { parseSourceOverride } from "../src/services/trackResolver.js";

test("isBlockedHost blocks localhost, private IPs, cloud metadata, and obfuscated IPs", () => {
  const blocked = [
    "localhost",
    "sub.localhost",
    "service.internal",
    "printer.local",
    "127.0.0.1",
    "127.12.34.56",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP/Azure metadata IP
    "100.64.0.1",
    "2130706433", // decimal 127.0.0.1
    "0x7f000001", // hex 127.0.0.1
    "0177.0.0.1", // octal 127.0.0.1
    "0x7f.0.0.1", // hex-dotted 127.0.0.1
    "127.1", // shorthand 127.0.0.1
    "::1",
    "[::1]",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "metadata.google.internal",
  ];

  for (const host of blocked) {
    assert.equal(isBlockedHost(host), true, `Expected ${host} to be blocked`);
  }

  const allowed = [
    "youtube.com",
    "open.spotify.com",
    "soundcloud.com",
    "8.8.8.8",
    "172.32.0.1",
    "192.169.1.1",
  ];

  for (const host of allowed) {
    assert.equal(isBlockedHost(host), false, `Expected ${host} to be allowed`);
  }
});

test("validateExternalUrl and validatePlayInput reject unsafe schemes, credentials, and oversized inputs", () => {
  assert.equal(validateExternalUrl("file:///etc/passwd").ok, false);
  assert.equal(validateExternalUrl("http://169.254.169.254/latest/meta-data/").ok, false);
  assert.equal(validateExternalUrl("http://user:pass@example.com/song.mp3").ok, false);
  assert.equal(validateExternalUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT").ok, true);

  assert.equal(validatePlayInput("").ok, false);
  assert.equal(validatePlayInput("a".repeat(501)).ok, false);
  assert.equal(validatePlayInput("http://127.0.0.1:2333/v4/info").ok, false);
  assert.deepEqual(validatePlayInput("daft punk\nget lucky"), {
    ok: true,
    query: "daft punk get lucky",
  });
});

test("RateLimiter enforces per-user cooldown and burst limits", () => {
  const limiter = new RateLimiter({ cooldownMs: 1000, windowMs: 10_000, maxPerWindow: 3 });

  assert.equal(limiter.check("u1", 1000).allowed, true);
  // Too fast (< 1000ms cooldown)
  const hitCooldown = limiter.check("u1", 1500);
  assert.equal(hitCooldown.allowed, false);
  assert.equal(hitCooldown.reason, "cooldown");

  // Two more valid commands within window
  assert.equal(limiter.check("u1", 2500).allowed, true);
  assert.equal(limiter.check("u1", 4000).allowed, true);

  // Fourth within 10s hits burst limit
  const hitBurst = limiter.check("u1", 5500);
  assert.equal(hitBurst.allowed, false);
  assert.equal(hitBurst.reason, "burst");

  // Separate user is unaffected
  assert.equal(limiter.check("u2", 5500).allowed, true);
});

test("checkAccess enforces server lock, admin-only commands, and DJ role rules", () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: "tok",
    OWNER_IDS: "111111111111111111",
    ALLOWED_GUILD_IDS: "999999999999999999",
    REQUIRE_DJ_ROLE: "true",
    DJ_ROLE_NAME: "DJ",
  });

  // Unauthorized guild rejected silently
  const wrongGuild = checkAccess({
    guildId: "888888888888888888",
    channelId: "123",
    userId: "222222222222222222",
    member: null,
    voiceChannel: null,
    player: null,
    commandName: "play",
    config: cfg,
  });
  assert.equal(wrongGuild.ok, false);
  assert.equal(wrongGuild.silent, true);

  // Regular member blocked from d!security / d!settings / d!nodes
  const regularMember = {
    permissions: { has: () => false },
    roles: { cache: { some: () => false } },
  };
  const nonAdminSec = checkAccess({
    guildId: "999999999999999999",
    channelId: "123",
    userId: "222222222222222222",
    member: regularMember,
    voiceChannel: null,
    player: null,
    commandName: "security",
    config: cfg,
  });
  assert.equal(nonAdminSec.ok, false);

  // Even an OWNER_ID user WITHOUT a role having Administrator or Manage Server is blocked from admin customization
  const ownerWithoutAdminRole = checkAccess({
    guildId: "999999999999999999",
    channelId: "123",
    userId: "111111111111111111",
    member: regularMember,
    voiceChannel: null,
    player: null,
    commandName: "settings",
    config: cfg,
  });
  assert.equal(ownerWithoutAdminRole.ok, false);

  // Role with Administrator permission is allowed
  const adminRoleMember = {
    permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    roles: {
      cache: {
        some: (fn) => fn({ name: "Admin", permissions: { has: (f) => f === PermissionFlagsBits.Administrator } }),
      },
    },
  };
  const adminSec = checkAccess({
    guildId: "999999999999999999",
    channelId: "123",
    userId: "222222222222222222",
    member: adminRoleMember,
    voiceChannel: null,
    player: null,
    commandName: "settings",
    config: cfg,
  });
  assert.equal(adminSec.ok, true);

  // Role with Manage Server (ManageGuild) permission is also allowed
  const managerRoleMember = {
    permissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild },
    roles: {
      cache: {
        some: (fn) => fn({ name: "Manager", permissions: { has: (f) => f === PermissionFlagsBits.ManageGuild } }),
      },
    },
  };
  const managerSec = checkAccess({
    guildId: "999999999999999999",
    channelId: "123",
    userId: "222222222222222222",
    member: managerRoleMember,
    voiceChannel: null,
    player: null,
    commandName: "settings",
    config: cfg,
  });
  assert.equal(managerSec.ok, true);

  // Regular member in shared VC blocked from d!stop when REQUIRE_DJ_ROLE=true
  const sharedVc = {
    members: {
      filter: (fn) => {
        const list = [
          { id: "222222222222222222", user: { bot: false } },
          { id: "333333333333333333", user: { bot: false } },
        ].filter(fn);
        return { size: list.length };
      },
    },
  };
  const noDjStop = checkAccess({
    guildId: "999999999999999999",
    channelId: "123",
    userId: "222222222222222222",
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
    voiceChannel: sharedVc,
    player: null,
    commandName: "stop",
    config: cfg,
  });
  assert.equal(noDjStop.ok, false);

  // Member with DJ role allowed
  const withDjStop = checkAccess({
    guildId: "999999999999999999",
    channelId: "123",
    userId: "222222222222222222",
    member: {
      permissions: { has: () => false },
      roles: { cache: { some: (fn) => fn({ id: "555", name: "DJ" }) } },
    },
    voiceChannel: sharedVc,
    player: null,
    commandName: "stop",
    config: cfg,
  });
  assert.equal(withDjStop.ok, true);
});

test("redactSecrets strips tokens and passwords from text", () => {
  const leaked = "Auth failed for token SUPER_SECRET_TOKEN_XYZ against pass MyLavaPass99!";
  assert.equal(
    redactSecrets(leaked, ["SUPER_SECRET_TOKEN_XYZ", "MyLavaPass99!"]),
    "Auth failed for token [REDACTED] against pass [REDACTED]",
  );
});

test("parseSourceOverride handles yt:, sc:, dz: prefixes without breaking https URLs", () => {
  assert.deepEqual(parseSourceOverride("sc:lofi beats", "ytmsearch"), {
    query: "lofi beats",
    source: "scsearch",
  });
  assert.deepEqual(parseSourceOverride("https://youtu.be/abc", "ytmsearch"), {
    query: "https://youtu.be/abc",
    source: "ytmsearch",
  });
});
