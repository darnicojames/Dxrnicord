import { hasAdminRole } from "../security/guard.js";

/**
 * Compute how many human listeners in the voice channel must agree to skip.
 * - 1 listener: 1 (instant)
 * - 2 listeners: 2 (both must agree)
 * - 3 listeners: 2 (majority)
 * - 4 listeners: 3 (majority)
 * - 5 listeners: 3 (majority)
 *
 * @param {number} humanCount
 * @returns {number}
 */
export function getRequiredSkipVotes(humanCount) {
  const n = Math.max(1, Number(humanCount) || 1);
  if (n === 1) return 1;
  return Math.floor(n / 2) + 1;
}

/**
 * Return Set of non-bot user IDs currently in the voice channel.
 * @param {any} voiceChannel
 * @returns {Set<string>}
 */
function getHumanListenerIds(voiceChannel) {
  const ids = new Set();
  const members = voiceChannel?.members;
  if (!members) return ids;

  const iterable = typeof members.values === "function" ? members.values() : members;
  for (const m of iterable) {
    if (m && !m.user?.bot && m.id) {
      ids.add(m.id);
    }
  }
  return ids;
}

/**
 * Reset vote-skip state when a track changes or stops.
 * @param {any} player
 */
export function resetSkipVotes(player) {
  if (!player?.deleteData) return;
  player.deleteData("skipVotes");
}

/**
 * Determine if a user has instant skip privilege (no vote needed).
 * Granted to:
 *  - Members holding a role with Administrator or Manage Server
 *  - The Session Host (first person who made the bot join the voice channel)
 *  - The requester of the currently playing song
 *  - A solo listener in the voice channel
 */
export function getInstantSkipReason({ player, member, userId, voiceChannel, voteSkipEnabled }) {
  if (!voteSkipEnabled) return "disabled";
  if (hasAdminRole(member)) return "admin";

  const sessionHostId = typeof player?.getData === "function" ? player.getData("sessionHostId") : null;
  if (sessionHostId && sessionHostId === userId) return "host";

  const requesterId = player?.queue?.current?.requester?.id;
  if (requesterId && requesterId === userId) return "requester";

  const humans = getHumanListenerIds(voiceChannel);
  if (humans.size <= 1) return "alone";

  return null;
}

/**
 * Check if a user is allowed to jump ahead multiple tracks (`d!skip <position>`).
 */
export function canJumpSkip({ player, member, userId, voiceChannel, voteSkipEnabled }) {
  return getInstantSkipReason({ player, member, userId, voiceChannel, voteSkipEnabled }) !== null;
}

/**
 * Evaluate a skip request (`d!skip` or Skip button) under session-host + vote-skip rules.
 *
 * @returns {{
 *   action: "skip" | "voted" | "already-voted",
 *   reason?: string,
 *   votes: number,
 *   required: number,
 *   remaining?: number
 * }}
 */
export function evaluateSkipRequest({ player, member, userId, voiceChannel, voteSkipEnabled = true }) {
  const instantReason = getInstantSkipReason({
    player,
    member,
    userId,
    voiceChannel,
    voteSkipEnabled,
  });

  if (instantReason) {
    resetSkipVotes(player);
    return { action: "skip", reason: instantReason, votes: 1, required: 1 };
  }

  const humans = getHumanListenerIds(voiceChannel);
  if (userId) humans.add(userId);
  const required = getRequiredSkipVotes(humans.size);

  const existing = player.getData("skipVotes");
  const votes = existing instanceof Set ? existing : new Set();

  // Prune anyone who left the voice channel since voting
  for (const voterId of [...votes]) {
    if (!humans.has(voterId)) votes.delete(voterId);
  }

  if (votes.has(userId)) {
    player.setData("skipVotes", votes);
    return {
      action: "already-voted",
      votes: votes.size,
      required,
      remaining: Math.max(0, required - votes.size),
    };
  }

  votes.add(userId);
  player.setData("skipVotes", votes);

  if (votes.size >= required) {
    resetSkipVotes(player);
    return { action: "skip", reason: "vote-passed", votes: votes.size, required };
  }

  return {
    action: "voted",
    votes: votes.size,
    required,
    remaining: required - votes.size,
  };
}
