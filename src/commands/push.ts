import mri from 'mri';
import type { Command } from './types.js';

const push: Command = {
    names: ['push'],
    async run({ mg, signal }, args) {
        const a = mri(args, { alias: { f: 'force' }, boolean: ['force', 'delete'] });
        const [remote, ref] = a._.map(String);
        await mg.push({
            remote: remote || 'origin',
            ref: ref || undefined,
            force: !!a.force,
            delete: !!a.delete,
            signal,
        });
        return '';
    },
};

export default push;
