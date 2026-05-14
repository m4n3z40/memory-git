import mri from 'mri';
import type { Command } from './types.js';

const clone: Command = {
    names: ['clone'],
    async run({ mg, signal }, args) {
        const a = mri(args, {
            alias: { b: 'branch' },
            boolean: ['single-branch', 'no-checkout'],
            string: ['branch'],
        });
        const url = String(a._[0] ?? '');
        if (!url) throw new Error('fatal: You must specify a repository to clone.');
        await mg.clone(url, {
            branch: a.branch ? String(a.branch) : undefined,
            singleBranch: !!a['single-branch'],
            noCheckout: !!a['no-checkout'],
            depth: a.depth ? Number(a.depth) : undefined,
            signal,
        });
        return `Cloning into '${mg.dir}'...`;
    },
};

export default clone;
