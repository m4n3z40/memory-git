import type { Command } from './types.js';

const remote: Command = {
    names: ['remote'],
    async run({ mg }, args) {
        const action = String(args[0] ?? '');
        if (!action || action === '-v' || action === '--verbose') {
            const r = await mg.listRemotes();
            return r.map(x => `${x.remote}\t${x.url}`).join('\n');
        }
        if (action === 'add') {
            await mg.addRemote(String(args[1] ?? ''), String(args[2] ?? ''));
            return '';
        }
        if (action === 'remove' || action === 'rm') {
            await mg.deleteRemote(String(args[1] ?? ''));
            return '';
        }
        throw new Error(`Unknown remote subcommand: ${action}`);
    },
};

export default remote;
