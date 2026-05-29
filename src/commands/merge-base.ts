import mri from 'mri';
import type { Command } from './types.js';

/**
 * `git merge-base --is-ancestor <maybeAncestor> <descendant>`.
 *
 * Yes → empty string (exit 0 in native git).
 * No  → `throw new Error('merge-base: not an ancestor')` with `.exitCode = 1`
 *       tacked on. Shell strategies wrapping `exec` inspect `.exitCode === 1`
 *       to map to native git's exit-1-empty-stderr, the same shape
 *       `diff --quiet` uses (the only other command in this codebase that
 *       distinguishes "negative answer" from "real failure" via exit code).
 * Bad ref / IO → regular Error without `.exitCode`, so the same strategy
 *       falls through to its generic "non-zero with stderr" path.
 *
 * Plain `git merge-base A B` (return the LCA) and `--octopus` are not yet
 * supported; rejected explicitly so callers know they need a different code
 * path rather than getting a silent wrong answer.
 */
const mergeBase: Command = {
    names: ['merge-base'],
    async run({ mg }, args) {
        const a = mri(args, { boolean: ['is-ancestor'] });
        if (a['is-ancestor']) {
            const [maybeAncestor, descendant] = a._.map(String);
            if (!maybeAncestor || !descendant) {
                throw new Error('memory-git: merge-base --is-ancestor requires two refs');
            }
            if (await mg.isAncestor(maybeAncestor, descendant)) return '';
            const err = new Error('merge-base: not an ancestor') as Error & { exitCode: number };
            err.exitCode = 1;
            throw err;
        }
        throw new Error('memory-git: only `git merge-base --is-ancestor A B` is supported');
    },
};

export default mergeBase;
