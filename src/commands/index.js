import {
  clearCommand,
  joinCommand,
  loopCommand,
  pauseCommand,
  removeCommand,
  seekCommand,
  shuffleCommand,
  skipCommand,
  stopCommand,
  volumeCommand,
} from "./controls.js";
import {
  autoplayCommand,
  emojisCommand,
  lyricsCommand,
  settingsCommand,
  stay247Command,
} from "./extras.js";
import {
  bassboostCommand,
  eqCommand,
  filterCommand,
  pitchCommand,
  resetFxCommand,
  speedCommand,
  trebleCommand,
} from "./filter.js";
import { helpCommand, securityCommand } from "./help.js";
import { nodesCommand } from "./nodes.js";
import { playCommand } from "./play.js";
import { nowPlayingCommand, queueCommand } from "./queue.js";
import { radioCommand } from "./radio.js";
import { searchCommand } from "./search.js";

export const commands = [
  helpCommand,
  joinCommand,
  playCommand,
  searchCommand,
  pauseCommand,
  skipCommand,
  stopCommand,
  queueCommand,
  nowPlayingCommand,
  volumeCommand,
  loopCommand,
  shuffleCommand,
  seekCommand,
  removeCommand,
  clearCommand,
  eqCommand,
  bassboostCommand,
  trebleCommand,
  speedCommand,
  pitchCommand,
  filterCommand,
  resetFxCommand,
  autoplayCommand,
  stay247Command,
  radioCommand,
  lyricsCommand,
  settingsCommand,
  nodesCommand,
  securityCommand,
  emojisCommand,
];

/** Map of canonical command names AND short aliases -> command object */
export const commandLookup = new Map();

for (const cmd of commands) {
  commandLookup.set(cmd.name.toLowerCase(), cmd);
  for (const alias of cmd.aliases || []) {
    commandLookup.set(alias.toLowerCase(), cmd);
  }
}

/**
 * Parse a Discord message starting with the configured prefix (e.g. "d!").
 * Returns null if the message does not start with the prefix.
 *
 * @param {string} content
 * @param {string} prefix
 * @returns {{ name: string, args: string[] } | null}
 */
export function parsePrefixCommand(content, prefix) {
  if (!content || !prefix) return null;
  if (!content.toLowerCase().startsWith(prefix.toLowerCase())) return null;

  const rest = content.slice(prefix.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);
  const name = parts.shift().toLowerCase();
  return { name, args: parts };
}
