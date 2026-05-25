import mri from 'mri';
import type { Command } from './types.js';

const tag: Command = {
    names: ['tag'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { a: 'annotated', d: 'delete', m: 'message', l: 'list', f: 'force' },
            boolean: ['annotated', 'list', 'force'],
            string: ['message', 'delete', 'points-at'],
        });
        if (a.delete) {
            await mg.deleteTag(String(a.delete));
            return `Deleted tag '${a.delete}'`;
        }
        // `git tag --points-at <ref>` lists every tag that points at <ref>.
        // Routed through tagsPointingAt's packed-refs fast path — O(1) on
        // cache hit, vs O(N) for the equivalent listTags + describeExact.
        if (a['points-at']) {
            const ref = String(a['points-at']);
            return (await mg.tagsPointingAt(ref)).join('\n');
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
