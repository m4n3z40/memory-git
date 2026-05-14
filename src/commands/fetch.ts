import mri from 'mri';
import type { Command } from './types.js';

const fetch: Command = {
    names: ['fetch'],
    async run({ mg, signal }, args) {
        const a = mri(args, { boolean: ['prune', 'tags', 'all'] });
        const remote = a._[0] ? String(a._[0]) : 'origin';
        await mg.fetch({
            remote,
            prune: !!a.prune,
            tags: !!a.tags,
            depth: a.depth ? Number(a.depth) : undefined,
            signal,
        });
        return '';
    },
};

export default fetch;
