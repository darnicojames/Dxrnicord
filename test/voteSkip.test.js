import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  canJumpSkip,
  evaluateSkipRequest,
  getRequiredSkipVotes,
  resetSkipVotes,
} from "../src/services/voteSkip.js";

function makeMember(roles = []) {
  return {
    roles: {
      cache: {
        some: (fn) => roles.some(fn),
      },
    },
  };
}

function makeVoiceChannel(userIds, botIds = ["bot-1"]) {
  const members = [
    ...userIds.map((id) => ({ id, user: { bot: false } })),
    ...botIds.map((id) => ({ id, user: { bot: true } })),
  ];
  return { members };
}

function makePlayer({ hostId, requesterId }) {
  const data = new Map();
  if (hostId) data.set("sessionHostId", hostId);
  return {
    getData: (k) => data.get(k),
    setData: (k, v) => data.set(k, v),
    deleteData: (k) => data.delete(k),
    queue: { current: { requester: { id: requesterId } } },
  };
}

test("getRequiredSkipVotes requires strict agreement/majority for 2+ listeners", () => {
  assert.equal(getRequiredSkipVotes(1), 1);
  assert.equal(getRequiredSkipVotes(2), 2);
  assert.equal(getRequiredSkipVotes(3), 2);
  assert.equal(getRequiredSkipVotes(4), 3);
  assert.equal(getRequiredSkipVotes(5), 3);
  assert.equal(getRequiredSkipVotes(6), 4);
});

test("session host (first VC summoner), track requester, and Admin/Manage Server roles skip immediately", () => {
  const vc = makeVoiceChannel(["host", "req", "userA", "userB"]);
  const player = makePlayer({ hostId: "host", requesterId: "req" });

  // Session host skips immediately even if someone else requested the current song
  const hostSkip = evaluateSkipRequest({
    player,
    member: makeMember(),
    userId: "host",
    voiceChannel: vc,
    voteSkipEnabled: true,
  });
  assert.equal(hostSkip.action, "skip");
  assert.equal(hostSkip.reason, "host");

  // Track requester skips immediately
  const reqSkip = evaluateSkipRequest({
    player,
    member: makeMember(),
    userId: "req",
    voiceChannel: vc,
    voteSkipEnabled: true,
  });
  assert.equal(reqSkip.action, "skip");
  assert.equal(reqSkip.reason, "requester");

  // Role with Manage Server skips immediately
  const adminSkip = evaluateSkipRequest({
    player,
    member: makeMember([
      { permissions: { has: (f) => f === PermissionFlagsBits.ManageGuild } },
    ]),
    userId: "userA",
    voiceChannel: vc,
    voteSkipEnabled: true,
  });
  assert.equal(adminSkip.action, "skip");
  assert.equal(adminSkip.reason, "admin");
});

test("other listeners must agree via d!skip (no double voting, prunes departed users)", () => {
  const vc = makeVoiceChannel(["host", "userA", "userB"]); // 3 listeners -> need 2 votes
  const player = makePlayer({ hostId: "host", requesterId: "host" });

  // Non-host cannot jump-skip multiple tracks
  assert.equal(
    canJumpSkip({ player, member: makeMember(), userId: "userA", voiceChannel: vc, voteSkipEnabled: true }),
    false,
  );
  assert.equal(
    canJumpSkip({ player, member: makeMember(), userId: "host", voiceChannel: vc, voteSkipEnabled: true }),
    true,
  );

  // First non-host votes -> 1/2
  const v1 = evaluateSkipRequest({
    player,
    member: makeMember(),
    userId: "userA",
    voiceChannel: vc,
    voteSkipEnabled: true,
  });
  assert.deepEqual(v1, { action: "voted", votes: 1, required: 2, remaining: 1 });

  // Same user voting again does not count twice
  const dup = evaluateSkipRequest({
    player,
    member: makeMember(),
    userId: "userA",
    voiceChannel: vc,
    voteSkipEnabled: true,
  });
  assert.deepEqual(dup, { action: "already-voted", votes: 1, required: 2, remaining: 1 });

  // Second listener agrees -> 2/2 -> skip!
  const v2 = evaluateSkipRequest({
    player,
    member: makeMember(),
    userId: "userB",
    voiceChannel: vc,
    voteSkipEnabled: true,
  });
  assert.equal(v2.action, "skip");
  assert.equal(v2.reason, "vote-passed");
  assert.equal(v2.votes, 2);

  // Vote-skip disabled -> immediate skip for anyone
  resetSkipVotes(player);
  const disabled = evaluateSkipRequest({
    player,
    member: makeMember(),
    userId: "userA",
    voiceChannel: vc,
    voteSkipEnabled: false,
  });
  assert.equal(disabled.action, "skip");
  assert.equal(disabled.reason, "disabled");
});
