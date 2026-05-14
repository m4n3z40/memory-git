/**
 * Shape of a subcommand handler used by the `exec` / `execStream` dispatcher.
 *
 * Each subcommand file (init.ts, add.ts, …) exports a `Command` and the
 * registry in `./index.ts` wires it up. Aliases are declared via the `names`
 * tuple — the first entry is the canonical name.
 *
 * To add a new subcommand:
 *   1. drop a new file in src/commands/<name>.ts exporting `const cmd: Command`
 *   2. register it in src/commands/index.ts
 * That's it — `exec` and `execStream` route to it automatically.
 */

import type { MemoryGit } from '../index.js';

export interface CommandContext {
    /** The MemoryGit instance this command runs against. */
    mg: MemoryGit;
    /** Cancellation signal forwarded from the caller (only meaningful for I/O). */
    signal?: AbortSignal;
}

export interface Command {
    /** Subcommand name + aliases. First entry is canonical (used in errors/docs). */
    readonly names: readonly string[];
    /** Execute the command, returning formatted CLI-style output. */
    run(ctx: CommandContext, args: string[]): Promise<string>;
    /**
     * Optional streaming variant — yields one logical line at a time. When
     * omitted, the dispatcher falls back to running `run()` and splitting on
     * `\n`. Useful for paginated or large outputs (log, ls-files, rev-list).
     */
    stream?(ctx: CommandContext, args: string[]): AsyncIterable<string>;
}
