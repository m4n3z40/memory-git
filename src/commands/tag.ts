import mri from 'mri';
import type { Command } from './types.js';

const tag: Command = {
    names: ['tag'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { a: 'annotated', d: 'delete', m: 'message', l: 'list', f: 'force' },
            boolean: ['annotated', 'list', 'force'],
            string: ['message', 'delete'],
        });
        if (a.delete) {
            await mg.deleteTag(String(a.delete));
            return `Deleted tag '${a.delete}'`;
        }
        if (a.list || a._.length === 0) {
            return (await mg.listTags()).join('\n');
        }
        const [name, ref] = a._.map(String);
        await mg.createTag(name, {
            ref: ref || 'HEAD',
            annotated: !!a.annotated,
            message: a.message ? String(a.message) : undefined,
            force: !!a.force,
        });
        return '';
    },
};

export default tag;
