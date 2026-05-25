import mri from 'mri';
import type { Command } from './types.js';

const packRefs: Command = {
    names: ['pack-refs'],
    async run({ mg }, args) {
        // git pack-refs accepts --all (default behavior here — we pack
        // every loose ref under refs/{heads,tags,remotes}), --prune
        // (always on — we delete loose files after packing), and
        // --no-prune (not supported; pruning is the whole point).
        const a = mri(args, { boolean: ['all', 'prune', 'no-prune'] });
        if (a['no-prune']) {
            throw new Error('memory-git: pack-refs --no-prune is not supported');
        }
        const { packed, removed } = await mg.packRefs();
        return `packed ${packed} refs, removed ${removed} loose files`;
    },
};

export default packRefs;
