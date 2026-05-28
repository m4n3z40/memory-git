import mri from 'mri';
import type { Command } from './types.js';
import { NotAncestorError } from '../errors.js';

/**
 * `git merge-base --is-ancestor <maybeAncestor> <descendant>`.
 *
 * Returns the empty string on success (exit 0 in native git) when
 * `maybeAncestor` is reachable from `descendant`. Throws `NotAncestorError`
 * (sentinel) when the answer is "no" — strategies wrapping `exec` map that
 * to native git's exit-1-empty-stderr without inspecting message strings.
 * Any other failure (bad ref, IO) throws a regular Error and should surface
 * as an exit code != 1 with stderr.
 *
 * Plain `git merge-base A B` (return the LCA) and `--octopus` are not yet
 * supported; this command rejects them explicitly so callers know they need
 * a different code path rather than getting a silent wrong answer.
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
            const ok = await mg.isAncestor(maybeAncestor, descendant);
            if (!ok) throw new NotAncestorError();
            return '';
        }
        throw new Error('memory-git: only `git merge-base --is-ancestor A B` is supported');
    },
};

export default mergeBase;
