import mri from 'mri';
import type { Command } from './types.js';

const add: Command = {
    names: ['add'],
    async run({ mg }, args) {
        const a = mri(args, { alias: { A: 'all', u: 'update' }, boolean: ['all', 'update'] });
        const paths = a._;
        if (a.all || a.update) {
            await mg.add([], { all: !!a.all, update: !!a.update });
        } else if (paths.length === 0) {
            throw new Error('Nothing specified, nothing added.');
        } else {
            await mg.add(paths.map(String));
        }
        return '';
    },
};

export default add;
