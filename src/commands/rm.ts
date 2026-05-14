import mri from 'mri';
import type { Command } from './types.js';

const rm: Command = {
    names: ['rm', 'remove'],
    async run({ mg }, args) {
        const a = mri(args, { boolean: ['cached', 'r', 'f'] });
        const file = String(a._[0] ?? '');
        if (!file) throw new Error('fatal: No pathspec given');
        await mg.remove(file, { cached: !!a.cached });
        return `rm '${file}'`;
    },
};

export default rm;
