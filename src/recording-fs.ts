/**
 * Recording fs wrapper.
 *
 * Wraps a memfs-shaped fs so every mutation (file write, delete, rename,
 * symlink) reports its path to `onMutate` before delegating to the underlying
 * fs. This is the single chokepoint that lets MemoryGit track *all*
 * unpersisted state — including writes that land only inside `.git/` (objects,
 * refs, index, HEAD) from commit/tag/merge/reset/etc., which never touch the
 * working tree and so were invisible to the workdir-only dirty set.
 *
 * Applied as the OUTERMOST fs layer, above the lazy wrapper. Lazy
 * materialization writes the inner volume directly (see lazy-fs.ts), so it
 * bypasses this wrapper and is correctly NOT recorded as a mutation — only
 * genuine writes reach `onMutate`. Reads, mkdir, stat and everything else pass
 * through untouched.
 */

import type { createFsFromVolume } from 'memfs';

import { normalize } from './fs-path.js';

type MemFs = ReturnType<typeof createFsFromVolume>;

/**
 * Wrap `memfs` so writes/deletes/renames/symlinks invoke `onMutate(memPath)`
 * (normalized) before being applied. The returned object exposes the exact
 * same surface (sync, callback-async, and `.promises`) as the input.
 */
export function wrapRecordingFs(memfs: MemFs, onMutate: (memPath: string) => void): MemFs {
    const mark = (p: unknown): void => onMutate(normalize(p as string | Buffer | URL));

    // ---------- sync ----------
    const writeFileSync = (p: any, data: any, opts?: any): void => {
        mark(p);
        return memfs.writeFileSync(p, data, opts);
    };
    const unlinkSync = (p: any): void => {
        mark(p);
        return memfs.unlinkSync(p);
    };
    const renameSync = (from: any, to: any): void => {
        mark(from);
        mark(to);
        return memfs.renameSync(from, to);
    };
    const symlinkSync = (target: any, p: any, type?: any): void => {
        mark(p);
        return memfs.symlinkSync(target, p, type);
    };

    // ---------- callback-async ----------
    const writeFile = (p: any, ...rest: any[]): void => {
        mark(p);
        return (memfs as any).writeFile(p, ...rest);
    };
    const unlink = (p: any, cb: any): void => {
        mark(p);
        return (memfs as any).unlink(p, cb);
    };
    const rename = (from: any, to: any, cb: any): void => {
        mark(from);
        mark(to);
        return (memfs as any).rename(from, to, cb);
    };
    const symlink = (target: any, p: any, ...rest: any[]): void => {
        mark(p);
        return (memfs as any).symlink(target, p, ...rest);
    };

    // ---------- promises ----------
    const promises = {
        writeFile: async (p: any, data: any, opts?: any) => {
            mark(p);
            return (memfs.promises as any).writeFile(p, data, opts);
        },
        unlink: async (p: any) => {
            mark(p);
            return (memfs.promises as any).unlink(p);
        },
        rename: async (from: any, to: any) => {
            mark(from);
            mark(to);
            return (memfs.promises as any).rename(from, to);
        },
        symlink: async (target: any, p: any, type?: any) => {
            mark(p);
            return (memfs.promises as any).symlink(target, p, type);
        },
    };

    const overrides: Record<string, any> = {
        writeFileSync, unlinkSync, renameSync, symlinkSync,
        writeFile, unlink, rename, symlink,
    };

    return new Proxy(memfs, {
        get(target, prop: string | symbol) {
            if (typeof prop === 'string') {
                if (prop === 'promises') {
                    return new Proxy((target as any).promises, {
                        get(pt, pp: string | symbol) {
                            if (typeof pp === 'string' && pp in promises) {
                                return (promises as any)[pp];
                            }
                            const v = (pt as any)[pp];
                            return typeof v === 'function' ? v.bind(pt) : v;
                        },
                    });
                }
                if (prop in overrides) return overrides[prop];
            }
            const v = (target as any)[prop];
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as MemFs;
}
