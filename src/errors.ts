/**
 * Typed sentinel thrown by `exec('merge-base --is-ancestor A B')` when A is
 * NOT an ancestor of B. Callers wrapping `exec` in a shell-like strategy
 * use `instanceof NotAncestorError` to map this to native git's exit code 1
 * with empty stderr — distinguishing the "negative answer" case from real
 * errors (bad refs, IO failures), which remain regular `Error`s and should
 * propagate as exit code != 1 with stderr.
 *
 * Lives in its own module so `src/commands/merge-base.ts` can import it
 * without pulling in `src/index.ts` (the public-API entry point), which would
 * create a circular import via the command registry.
 */
export class NotAncestorError extends Error {
    constructor(message: string = 'not an ancestor') {
        super(message);
        this.name = 'NotAncestorError';
    }
}
