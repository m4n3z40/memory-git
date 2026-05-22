import mri from 'mri';
import type { Command } from './types.js';

function looksLikeUrl(s: string): boolean {
    return /^(https?|git|ssh|file):\/\//.test(s) || /^[^/@\s]+@[^:]+:/.test(s);
}

const pull: Command = {
    names: ['pull'],
    async run({ mg, signal }, args) {
        const a = mri(args, { boolean: ['ff-only', 'ff'] });
        const [first, branch] = a._.map(String);
        const target = first
            ? (looksLikeUrl(first) ? { url: first } : { remote: first })
            : { remote: 'origin' };
        await mg.pull({
            ...target,
            branch: branch || undefined,
            fastForwardOnly: !!a['ff-only'],
            signal,
        });
        return '';
    },
};

export default pull;
