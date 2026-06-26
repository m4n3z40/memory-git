import mri from 'mri';
import type { Command } from './types.js';

/**
 * `git for-each-ref [--count=<n>] [--sort=<key>]... [--format=<fmt>] [<pattern>...]`.
 *
 * Thin CLI wrapper over `MemoryGit.forEachRef` — parse args, join the lines.
 * All the laziness (sort names, slice to --count, resolve only the survivors)
 * lives in the method. Default format and output shape match native git.
 */
const forEachRef: Command = {
    names: ['for-each-ref'],
    async run({ mg }, args) {
        const a = mri(args, {
            string: ['format', 'sort', 'count'],
        });
        // --sort is repeatable: mri gives a string for one, an array for many.
        const sortRaw = a.sort;
        const sort = sortRaw == null ? undefined
            : Array.isArray(sortRaw) ? sortRaw.map(String)
            : [String(sortRaw)];
        const lines = await mg.forEachRef({
            patterns: a._.map(String),
            sort,
            count: a.count != null ? Number(a.count) : undefined,
            format: a.format != null ? String(a.format) : undefined,
        });
        return lines.join('\n');
    },
};

export default forEachRef;
