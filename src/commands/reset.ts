import mri from 'mri';
import type { Command } from './types.js';
import type { ResetMode } from '../types.js';

const reset: Command = {
    names: ['reset'],
    async run({ mg }, args) {
        const a = mri(args, { boolean: ['soft', 'mixed', 'hard'] });
        const positional = a._.map(String);
        const sep = positional.indexOf('--');
        const refs = sep >= 0 ? positional.slice(0, sep) : positional;
        const paths = sep >= 0 ? positional.slice(sep + 1) : undefined;
        const mode: ResetMode = a.hard ? 'hard' : a.soft ? 'soft' : 'mixed';
        const ref = refs[0] ?? 'HEAD';
        await mg.reset(ref, { mode, paths });
        return '';
    },
};

export default reset;
