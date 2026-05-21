import mri from 'mri';
import type { Command } from './types.js';

const describe: Command = {
    names: ['describe'],
    async run({ mg }, args) {
        const a = mri(args, { boolean: ['exact-match', 'tags'] });
        if (!a['exact-match'] || !a.tags) {
            throw new Error('memory-git: only `describe --exact-match --tags <ref>` is supported');
        }
        const ref = a._[0] ? String(a._[0]) : 'HEAD';
        const tag = await mg.describeExact(ref);
        if (tag === null) {
            throw new Error(`fatal: no tag exactly matches '${ref}'`);
        }
        return tag;
    },
};

export default describe;
