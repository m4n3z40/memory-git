/**
 * Path helpers shared by the fs wrappers (lazy-fs, recording-fs).
 */

import pathNode from 'path';

/**
 * Coerce an fs path argument (string, Buffer, or file URL) to a
 * posix-normalized string, matching how memfs keys its in-memory volume.
 */
export function normalize(p: string | Buffer | URL): string {
    const s = typeof p === 'string' ? p : p instanceof URL ? p.pathname : p.toString();
    return pathNode.posix.normalize(s);
}
