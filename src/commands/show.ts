import mri from 'mri';
import type { Command } from './types.js';

const show: Command = {
    names: ['show'],
    async run({ mg }, args) {
        const a = mri(args);
        const ref = a._[0] ? String(a._[0]) : 'HEAD';
        const r = await mg.show(ref);
        const lines = [
            `commit ${r.commit.sha}`,
            `Author: ${r.commit.author} <${r.commit.email}>`,
            `Date:   ${new Date(r.commit.timestamp).toString()}`,
            '',
            `    ${r.commit.message.trim().replace(/\n/g, '\n    ')}`,
            '',
            ...r.changes.map(c => `${c.status[0].toUpperCase()}\t${c.filepath}`),
        ];
        return lines.join('\n');
    },
};

export default show;
