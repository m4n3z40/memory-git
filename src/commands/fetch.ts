import mri from 'mri';
import type { Command } from './types.js';

function looksLikeUrl(s: string): boolean {
    return /^(https?|git|ssh|file):\/\//.test(s) || /^[^/@\s]+@[^:]+:/.test(s);
}

const fetch: Command = {
    names: ['fetch'],
    async run({ mg, signal }, args) {
        const a = mri(args, { boolean: ['prune', 'tags', 'all'] });
        const [first, second] = a._.map(String);
        const target = first
            ? (looksLikeUrl(first) ? { url: first } : { remote: first })
            : { remote: 'origin' };
        await mg.fetch({
            ...target,
            ref: second || undefined,
            prune: !!a.prune,
            tags: !!a.tags,
            depth: a.depth ? Number(a.depth) : undefined,
            signal,
        });
        return '';
    },
};

export default fetch;
