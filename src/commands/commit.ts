import mri from 'mri';
import type { Author } from '../types.js';
import type { Command, CommandContext } from './types.js';

/** Parses `Name <email>` or bare `Name` into an Author, falling back to the instance default email. */
function parseAuthor(s: string, fallback: Author): Author {
    const m = s.match(/^\s*(.+?)\s*<(.+?)>\s*$/);
    if (m) return { name: m[1], email: m[2] };
    return { name: s.trim(), email: fallback.email };
}

const commit: Command = {
    names: ['commit'],
    async run({ mg }: CommandContext, args) {
        const a = mri(args, {
            alias: { m: 'message', a: 'all' },
            boolean: ['amend', 'allow-empty', 'all'],
            string: ['message', 'author', 'date'],
        });
        const message = String(a.message ?? '');
        const sha = await mg.commit(message, {
            amend: !!a.amend,
            allowEmpty: !!a['allow-empty'],
            all: !!a.all,
            date: a.date ? new Date(String(a.date)) : undefined,
            author: a.author ? parseAuthor(String(a.author), mg.author) : undefined,
        });
        const branch = (await mg.currentBranch()) ?? 'HEAD';
        return `[${branch} ${sha.slice(0, 7)}] ${message.split('\n')[0]}`;
    },
};

export default commit;
