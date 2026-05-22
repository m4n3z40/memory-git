import mri from 'mri';
import type { Command } from './types.js';

function looksLikeUrl(s: string): boolean {
    return /^(https?|git|ssh|file):\/\//.test(s) || /^[^/@\s]+@[^:]+:/.test(s);
}

const push: Command = {
    names: ['push'],
    async run({ mg, signal }, args) {
        const a = mri(args, { alias: { f: 'force' }, boolean: ['force', 'delete'] });
        const [first, ref] = a._.map(String);
        const target = first
            ? (looksLikeUrl(first) ? { url: first } : { remote: first })
            : { remote: 'origin' };
        await mg.push({
            ...target,
            ref: ref || undefined,
            force: !!a.force,
            delete: !!a.delete,
            signal,
        });
        return '';
    },
};

export default push;
