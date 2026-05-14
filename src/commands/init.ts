import mri from 'mri';
import type { Command } from './types.js';

const init: Command = {
    names: ['init'],
    async run({ mg }, args) {
        const a = mri(args, { alias: { b: 'initial-branch' }, boolean: ['bare'] });
        await mg.init({
            defaultBranch: (a['initial-branch'] as string) || undefined,
            bare: !!a.bare,
        });
        return `Initialized empty Git repository in ${mg.dir}/.git/`;
    },
};

export default init;
