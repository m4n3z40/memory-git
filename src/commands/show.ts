import mri from 'mri';
import type { Command } from './types.js';

const show: Command = {
    names: ['show'],
    async run({ mg }, args) {
        const a = mri(args);
        const spec = a._[0] ? String(a._[0]) : 'HEAD';

        // `git show <ref>:<path>` prints the blob contents at that path in
        // the given ref (cat-file in disguise). We split on the FIRST colon
        // so refs like `refs/heads/main:src/x.ts` keep the path intact.
        const colon = spec.indexOf(':');
        if (colon >= 0) {
            const ref = spec.slice(0, colon) || 'HEAD';
            const filepath = spec.slice(colon + 1);
            const content = await mg.readFileAtRef(filepath, ref);
            return typeof content === 'string' ? content : content.toString('utf8');
        }

        const r = await mg.show(spec);
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
