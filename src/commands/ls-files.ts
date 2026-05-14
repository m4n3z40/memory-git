import type { Command } from './types.js';

const lsFiles: Command = {
    names: ['ls-files'],
    async run({ mg }) {
        return (await mg.listTrackedFiles()).join('\n');
    },
    async *stream({ mg, signal }) {
        const files = await mg.listTrackedFiles();
        for (const f of files) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            yield f;
        }
    },
};

export default lsFiles;
