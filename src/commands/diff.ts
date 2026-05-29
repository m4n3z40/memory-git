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
            boolean: ['cached', 'staged', 'name-only', 'name-status', 'quiet', 'stat'],
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
        // Format precedence matches git: --name-only / --name-status / --stat
        // pick the shape; otherwise (and by default) emit unified diff.
        const nameOnly = !!a['name-only'];
        const nameStatus = !!a['name-status'];
        const stat = !!a.stat;
        const unified = !nameOnly && !nameStatus && !stat;
        return mg.diffText({ ...diffOpts, nameOnly, nameStatus, stat, unified });
    },
};

export default diff;
