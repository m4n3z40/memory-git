import mri from 'mri';
import type { Command } from './types.js';
import type { LsTreeOptions } from '../types.js';

/** Translate parsed CLI flags + the tree-ish + pathspecs into LsTreeOptions. */
function toOptions(args: string[]): LsTreeOptions {
    const a = mri(args, {
        alias: { r: 'recursive', t: 'show-trees' },
        boolean: ['recursive', 'name-only', 'show-trees'],
    });
    const positionals = a._.map(String);
    // First positional is the tree-ish; the rest are pathspecs (git ls-tree
    // <tree-ish> [<path>...]). Default to HEAD when none is given.
    const [treeish, ...pathspecs] = positionals;
    return {
        treeish: treeish ?? 'HEAD',
        recursive: !!a.recursive,
        nameOnly: !!a['name-only'],
        showTrees: !!a['show-trees'],
        pathspecs,
    };
}

const lsTree: Command = {
    names: ['ls-tree'],
    async run({ mg }, args) {
        const opts = toOptions(args);
        const entries = await mg.lsTree(opts);
        if (opts.nameOnly) {
            return entries.map(e => e.path).join('\n');
        }
        // Full form: `<mode> <type> <oid>\t<path>` — matches `git ls-tree`.
        return entries.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.path}`).join('\n');
    },
    async *stream({ mg, signal }, args) {
        const opts = toOptions(args);
        const entries = await mg.lsTree(opts);
        for (const e of entries) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            yield opts.nameOnly ? e.path : `${e.mode} ${e.type} ${e.oid}\t${e.path}`;
        }
    },
};

export default lsTree;
