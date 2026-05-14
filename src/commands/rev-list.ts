import mri from 'mri';
import type { Command } from './types.js';
import type { RevListOptions } from '../types.js';

function parseArgs(args: string[]): RevListOptions {
    const a = mri(args, {
        boolean: ['all', 'reverse'],
        alias: { 'max-count': 'n' },
    });
    return {
        all: !!a.all,
        reverse: !!a.reverse,
        maxCount: a['max-count'] ? Number(a['max-count']) : undefined,
        ref: a._[0] ? String(a._[0]) : undefined,
    };
}

const revList: Command = {
    names: ['rev-list'],
    async run({ mg }, args) {
        const oids = await mg.revList(parseArgs(args));
        return oids.join('\n');
    },
    async *stream({ mg, signal }, args) {
        const oids = await mg.revList(parseArgs(args));
        for (const oid of oids) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            yield oid;
        }
    },
};

export default revList;
