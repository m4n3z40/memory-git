import mri from 'mri';
import type { Command } from './types.js';

const diff: Command = {
    names: ['diff'],
    async run({ mg }, args) {
        const a = mri(args, {
            boolean: ['cached', 'staged', 'name-only', 'name-status'],
        });
        const refs = a._.map(String);
        return mg.diffText({
            cached: !!(a.cached || a.staged),
            fromRef: refs[0],
            toRef: refs[1],
            nameOnly: !!a['name-only'],
            nameStatus: !!a['name-status'],
        });
    },
};

export default diff;
