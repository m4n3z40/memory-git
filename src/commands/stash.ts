import type { Command } from './types.js';

const stash: Command = {
    names: ['stash'],
    async run({ mg }, args) {
        const action = String(args[0] ?? 'push');
        if (action === 'push' || !args[0]) {
            const n = await mg.stash();
            return `Saved working directory and index state (${n} files)`;
        }
        if (action === 'pop') {
            const n = await mg.stashPop();
            return `Restored ${n} files from stash`;
        }
        if (action === 'list') {
            const n = mg.stashList();
            return Array.from({ length: n }, (_, i) => `stash@{${i}}`).join('\n');
        }
        throw new Error(`Unknown stash action: ${action}`);
    },
};

export default stash;
