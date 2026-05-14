import mri from 'mri';
import type { Command } from './types.js';

const pull: Command = {
    names: ['pull'],
    async run({ mg, signal }, args) {
        const a = mri(args, { boolean: ['ff-only', 'ff'] });
        const [remote, branch] = a._.map(String);
        await mg.pull({
            remote: remote || 'origin',
            branch: branch || undefined,
            fastForwardOnly: !!a['ff-only'],
            signal,
        });
        return '';
    },
};

export default pull;
