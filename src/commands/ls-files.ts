import mri from 'mri';
import type { Command } from './types.js';
import type { LsFilesOptions } from '../types.js';

/** Translate parsed CLI flags + positional pathspecs into LsFilesOptions. */
function toOptions(args: string[]): LsFilesOptions {
    const a = mri(args, {
        alias: { c: 'cached', o: 'others', m: 'modified', d: 'deleted' },
        boolean: ['cached', 'others', 'modified', 'deleted', 'exclude-standard'],
    });
    return {
        pathspecs: a._.map(String),
        cached: !!a.cached,
        others: !!a.others,
        modified: !!a.modified,
        deleted: !!a.deleted,
        excludeStandard: !!a['exclude-standard'],
    };
}

const lsFiles: Command = {
    names: ['ls-files'],
    async run({ mg }, args) {
        return (await mg.lsFiles(toOptions(args))).join('\n');
    },
    async *stream({ mg, signal }, args) {
        const files = await mg.lsFiles(toOptions(args));
        for (const f of files) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            yield f;
        }
    },
};

export default lsFiles;
