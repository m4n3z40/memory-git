import mri from 'mri';
import type { Command } from './types.js';

const revParse: Command = {
    names: ['rev-parse'],
    async run({ mg }, args) {
        const a = mri(args, { boolean: ['short', 'abbrev-ref'] });
        const ref = String(a._[0] ?? 'HEAD');
        return mg.resolveRef(ref, { short: !!a.short, abbrevRef: !!a['abbrev-ref'] });
    },
};

export default revParse;
