import mri from 'mri';
import type { Command } from './types.js';

const checkout: Command = {
    names: ['checkout'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { b: 'create-branch', f: 'force' },
            boolean: ['create-branch', 'force'],
        });
        const positional = a._.map(String);
        const sep = positional.indexOf('--');
        const refs = sep >= 0 ? positional.slice(0, sep) : positional;
        const files = sep >= 0 ? positional.slice(sep + 1) : undefined;
        const ref = refs[0];
        if (!ref) throw new Error('fatal: you must specify a branch or ref');
        await mg.checkout(ref, {
            createBranch: !!a['create-branch'],
            force: !!a.force,
            files,
        });
        return a['create-branch']
            ? `Switched to a new branch '${ref}'`
            : `Switched to branch '${ref}'`;
    },
};

export default checkout;
