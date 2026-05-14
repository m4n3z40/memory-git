import mri from 'mri';
import type { Command } from './types.js';

const mv: Command = {
    names: ['mv'],
    async run({ mg }, args) {
        const a = mri(args, { boolean: ['f'] });
        const [from, to] = a._.map(String);
        if (!from || !to) throw new Error('fatal: bad source/destination');
        await mg.rename(from, to, { force: !!a.f });
        return '';
    },
};

export default mv;
