import mri from 'mri';
import type { Command } from './types.js';
import type { DiffFilterCode } from '../types.js';

const VALID_FILTER_CODES = new Set(['A', 'C', 'D', 'M', 'R', 'T', 'U', 'X', 'B']);

function parseFilter(raw: unknown): DiffFilterCode[] | undefined {
    if (raw === undefined || raw === null || raw === false) return undefined;
    const codes = String(raw).toUpperCase().split('').filter(c => VALID_FILTER_CODES.has(c));
    return codes.length > 0 ? (codes as DiffFilterCode[]) : undefined;
}

const diff: Command = {
    names: ['diff'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { q: 'quiet' },
            boolean: ['cached', 'staged', 'name-only', 'name-status', 'quiet'],
            string: ['diff-filter'],
        });
        const refs = a._.map(String);
        const diffOpts = {
            cached: !!(a.cached || a.staged),
            fromRef: refs[0],
            toRef: refs[1],
            filter: parseFilter(a['diff-filter']),
        };
        if (a.quiet) {
            if (!(await mg.hasDiff(diffOpts))) return '';
            const err = new Error('diff: changes present') as Error & { exitCode: number };
            err.exitCode = 1;
            throw err;
        }
        return mg.diffText({
            ...diffOpts,
            nameOnly: !!a['name-only'],
            nameStatus: !!a['name-status'],
        });
    },
};

export default diff;
