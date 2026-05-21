import mri from 'mri';
import type { Command } from './types.js';

const showRef: Command = {
    names: ['show-ref'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { d: 'dereference' },
            boolean: ['tags', 'dereference', 'head'],
        });
        if (!a.tags) {
            throw new Error('memory-git: only `show-ref --tags` is supported');
        }
        const refs = await mg.showTagRefs();
        if (refs.length === 0) return '';
        return refs.map(r => `${r.commitOid} refs/tags/${r.tagName}`).join('\n');
    },
};

export default showRef;
