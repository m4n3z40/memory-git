import mri from 'mri';
import type { Command } from './types.js';

const branch: Command = {
    names: ['branch'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { d: 'delete', D: 'delete-force', m: 'move' },
            string: ['delete', 'delete-force'],
            boolean: ['move', 'show-current'],
        });
        if (a['show-current']) {
            return (await mg.currentBranch()) ?? '';
        }
        if (a.move) {
            const [oldN, newN] = a._.map(String);
            if (!oldN || !newN) throw new Error('branch -m requires <old> <new>');
            await mg.renameBranch(oldN, newN);
            return '';
        }
        if (a['delete-force']) {
            await mg.deleteBranch(String(a['delete-force']), { force: true });
            return '';
        }
        if (a.delete) {
            await mg.deleteBranch(String(a.delete));
            return '';
        }
        if (a._.length > 0) {
            await mg.createBranch(String(a._[0]));
            return '';
        }
        return mg.branchText();
    },
};

export default branch;
