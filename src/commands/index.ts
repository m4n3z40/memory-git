/**
 * Command registry for the `exec` / `execStream` dispatcher.
 *
 * One file per subcommand under this folder. Each exports a `Command` with
 * `names` (canonical + aliases) and a `run` (and optional `stream`).
 *
 * Add a new subcommand: create the file, import it here, and call `register`.
 */

import type { Command } from './types.js';

import init from './init.js';
import add from './add.js';
import rm from './rm.js';
import mv from './mv.js';
import commit from './commit.js';
import status from './status.js';
import log from './log.js';
import show from './show.js';
import diff from './diff.js';
import branch from './branch.js';
import checkout from './checkout.js';
import merge from './merge.js';
import tag from './tag.js';
import reset from './reset.js';
import clone from './clone.js';
import fetch from './fetch.js';
import pull from './pull.js';
import push from './push.js';
import remote from './remote.js';
import config from './config.js';
import stash from './stash.js';
import revParse from './rev-parse.js';
import lsFiles from './ls-files.js';
import revList from './rev-list.js';
import showRef from './show-ref.js';
import describe from './describe.js';

const REGISTRY = new Map<string, Command>();
function register(cmd: Command): void {
    for (const name of cmd.names) REGISTRY.set(name, cmd);
}

register(init);
register(add);
register(rm);
register(mv);
register(commit);
register(status);
register(log);
register(show);
register(diff);
register(branch);
register(checkout);
register(merge);
register(tag);
register(reset);
register(clone);
register(fetch);
register(pull);
register(push);
register(remote);
register(config);
register(stash);
register(revParse);
register(lsFiles);
register(revList);
register(showRef);
register(describe);

/** Resolve a subcommand by name (or alias). Returns `undefined` if unknown. */
export function getCommand(name: string): Command | undefined {
    return REGISTRY.get(name);
}

/** List every registered canonical subcommand name. */
export function listCommands(): string[] {
    const seen = new Set<string>();
    for (const cmd of REGISTRY.values()) seen.add(cmd.names[0]);
    return [...seen].sort();
}

export type { Command, CommandContext } from './types.js';
