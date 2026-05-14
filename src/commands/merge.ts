import mri from 'mri';
import type { Command } from './types.js';

const merge: Command = {
    names: ['merge'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { m: 'message' },
            boolean: ['no-ff', 'ff-only'],
            string: ['message'],
        });
        const branch = String(a._[0] ?? '');
        if (!branch) throw new Error('fatal: No branch specified');
        const result = await mg.merge(branch, {
            noFastForward: !!a['no-ff'],
            fastForwardOnly: !!a['ff-only'],
            message: a.message ? String(a.message) : undefined,
        });
        if (result.alreadyMerged) return 'Already up to date.';
        if (result.fastForward) return `Fast-forward to ${result.oid?.slice(0, 7)}`;
        return `Merge made by recursive into ${(await mg.currentBranch()) ?? 'HEAD'}`;
    },
};

export default merge;
