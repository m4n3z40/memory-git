import mri from 'mri';
import type { Command } from './types.js';

function parseStrategy(raw: unknown): 'ours' | 'theirs' | undefined {
    if (raw === 'ours' || raw === 'theirs') return raw;
    return undefined;
}

const merge: Command = {
    names: ['merge'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { m: 'message', s: 'strategy', X: 'strategy-option' },
            boolean: ['no-ff', 'ff-only', 'abort', 'allow-unrelated-histories', 'no-edit'],
            string: ['message', 'strategy', 'strategy-option'],
        });
        if (a.abort) {
            await mg.abortMerge();
            return '';
        }
        const branch = String(a._[0] ?? '');
        if (!branch) throw new Error('fatal: No branch specified');
        const result = await mg.merge(branch, {
            noFastForward: !!a['no-ff'],
            fastForwardOnly: !!a['ff-only'],
            message: a.message ? String(a.message) : undefined,
            allowUnrelatedHistories: !!a['allow-unrelated-histories'],
            strategy: parseStrategy(a['strategy-option']),
        });
        if (result.alreadyMerged) return 'Already up to date.';
        if (result.fastForward) return `Fast-forward to ${result.oid?.slice(0, 7)}`;
        return `Merge made by recursive into ${(await mg.currentBranch()) ?? 'HEAD'}`;
    },
};

export default merge;
