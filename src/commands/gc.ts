import mri from 'mri';
import type { Command } from './types.js';

const gc: Command = {
    names: ['gc'],
    async run({ mg }, args) {
        // --aggressive: native git uses this to try harder delta compression.
        // We have no custom delta strategy, so it's accepted but a no-op.
        // --prune=<date>: native git keeps unreachable objects with mtime
        // newer than <date>. We have no reflog and packObjects only includes
        // reachable OIDs, so the effective behavior is always --prune=now.
        const a = mri(args, {
            boolean: ['aggressive', 'auto', 'quiet', 'no-prune'],
            string: ['prune'],
        });
        const result = await mg.gc();
        if (a.quiet) return '';
        const lines: string[] = [];
        if (result.reachableObjects === 0) {
            lines.push('Nothing new to pack.');
        } else {
            lines.push(`Counting objects: ${result.reachableObjects}, done.`);
            lines.push(
                `Writing ${result.packFilename} (${result.packSizeBytes} bytes), ` +
                `removed ${result.looseDeleted} loose objects, ${result.packsRemoved} stale packs.`,
            );
        }
        return lines.join('\n');
    },
};

export default gc;
