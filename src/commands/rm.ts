import mri from 'mri';
import type { Command } from './types.js';

const rm: Command = {
    names: ['rm', 'remove'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { r: 'recursive' },
            boolean: ['cached', 'recursive', 'r', 'f', 'force', 'ignore-unmatch'],
        });
        const paths = a._.map(String).filter(Boolean);
        if (paths.length === 0) throw new Error('fatal: No pathspec given');
        const removed = await mg.remove(paths, {
            cached: !!a.cached,
            recursive: !!a.recursive,
            ignoreUnmatch: !!a['ignore-unmatch'],
        });
        return removed.map(f => `rm '${f}'`).join('\n');
    },
};

export default rm;
