/**
 * Disk ↔ memfs sync primitives.
 *
 * Pure helpers that take a memfs IFs and a real-disk path. MemoryGit's
 * `loadFromDisk`/`flush`/`listFiles`/`reset --hard` methods compose these;
 * they live here so the index.ts class stays focused on git semantics.
 *
 * .gitignore handling and the parallel async copy walk were tuned in 3.0 —
 * see the patterns in `collectGitignorePatterns` and the in-flight ignore-rule
 * probe in `copyDiskToMemory` before changing.
 */

import { promises as fsRealAsync } from 'fs';
import type { Dirent } from 'fs';
import { createHash } from 'crypto';
import pathNode from 'path';
import type { createFsFromVolume } from 'memfs';
import type ignore from 'ignore';

export type MemFs = ReturnType<typeof createFsFromVolume>;
export type Matcher = ReturnType<typeof ignore>;

/**
 * One row of the disk-sync snapshot. Tracks the state of a file on disk at
 * the moment it was last read or written by us. The `size + mtimeMs` pair is
 * the fast pre-filter for disk→memory (skip without reading); `hash` is the
 * authoritative comparator for memory→disk (skip without writing).
 */
export interface FileFingerprint {
    size: number;
    mtimeMs: number;
    hash: string;
}

/** SHA-1 of a buffer, hex-encoded. Same algorithm git uses internally. */
export function hashBuffer(buf: Buffer): string {
    return createHash('sha1').update(buf).digest('hex');
}

/**
 * Paths whose content is fully determined by the filename. Real git keeps
 * these at mode 0444, so any flush that re-writes them races into EACCES.
 *
 * Matches:
 *   - loose objects:   .git/objects/<2 hex>/<remaining hex>
 *   - packed objects:  .git/objects/pack/pack-<hex>.{pack,idx,rev,mtimes,bitmap}
 *
 * The repo root prefix (`.git/`) is matched against the repo-relative form,
 * so this works for both the top-level walk and nested recursion.
 */
const IMMUTABLE_OBJECT_RE =
    /^\.git\/objects\/(?:[0-9a-f]{2}\/[0-9a-f]+|pack\/pack-[0-9a-f]+\.(?:pack|idx|rev|mtimes|bitmap))$/;

export function isImmutableObjectPath(relPath: string): boolean {
    return IMMUTABLE_OBJECT_RE.test(relPath);
}

/** Cheap existence probe — `access` is the smallest "does it exist" call. */
export async function realPathExists(filepath: string): Promise<boolean> {
    try {
        await fsRealAsync.access(filepath);
        return true;
    } catch {
        return false;
    }
}

/**
 * True iff a node fs error is ENOENT — file/dir vanished. We use this in the
 * incremental disk→memory walk to tolerate a concurrent mutator (native git
 * gc/repack/prune deleting object dirs, branch updates rotating refs) without
 * tearing down the whole walk. The alternative — propagating ENOENT — left
 * memfs and the disk-snapshot half-updated, which produced the pack/idx
 * mtime divergence corruption observed in prod.
 */
function isENOENT(err: unknown): boolean {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Walk the source tree and collect every .gitignore's patterns, translated to
 * root-relative form. Nested files get a path prefix; leading `!` (negation)
 * and `/` (anchored) are preserved.
 */
export async function collectGitignorePatterns(root: string, nested: boolean): Promise<string[]> {
    const patterns: string[] = [];

    const readGitignore = async (filePath: string, prefix: string) => {
        try {
            const content = await fsRealAsync.readFile(filePath, 'utf8');
            for (const raw of content.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line || line.startsWith('#')) continue;
                if (!prefix) {
                    patterns.push(line);
                } else {
                    // Translate a nested-gitignore pattern into a root-relative pattern.
                    const negated = line.startsWith('!');
                    const body = negated ? line.slice(1) : line;
                    const anchored = body.startsWith('/');
                    const cleaned = anchored ? body.slice(1) : body;
                    const prefixed = anchored
                        ? `${prefix}/${cleaned}`
                        : `${prefix}/**/${cleaned}`;
                    patterns.push(negated ? `!${prefixed}` : prefixed);
                }
            }
        } catch {
            // No .gitignore at this location
        }
    };

    await readGitignore(pathNode.join(root, '.gitignore'), '');

    if (nested) {
        const walk = async (dir: string, rel: string): Promise<void> => {
            let entries: Dirent[];
            try {
                entries = await fsRealAsync.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            await Promise.all(entries.map(async entry => {
                if (entry.name === '.git' || entry.name === 'node_modules') return;
                const full = pathNode.join(dir, entry.name);
                const relPath = rel ? pathNode.posix.join(rel, entry.name) : entry.name;
                if (entry.isDirectory()) {
                    await readGitignore(pathNode.join(full, '.gitignore'), relPath);
                    await walk(full, relPath);
                }
            }));
        };
        await walk(root, '');
    }

    return patterns;
}

/**
 * Copy a real directory tree into the in-memory Volume. Returns the file
 * count. The repo's own `.git/` is always copied even when the matcher would
 * exclude it — that's the git database we need. Subtree reads run in parallel.
 */
export async function copyDiskToMemory(
    fs: MemFs,
    realPath: string,
    memoryPath: string,
    matcher: Matcher,
    relPath: string,
): Promise<number> {
    const entries = await fsRealAsync.readdir(realPath, { withFileTypes: true });

    const promises = entries.map(async (entry) => {
        const entryRel = relPath ? pathNode.posix.join(relPath, entry.name) : entry.name;

        // Always load the repo's own .git/ regardless of ignore patterns.
        const insideGit = entryRel === '.git' || entryRel.startsWith('.git/');
        if (!insideGit) {
            // ignore() requires a trailing slash on directories to apply directory-only rules
            const probe = entry.isDirectory() ? `${entryRel}/` : entryRel;
            if (matcher.ignores(probe)) return 0;
        }

        const realEntryPath = pathNode.join(realPath, entry.name);
        const memoryEntryPath = pathNode.posix.join(memoryPath, entry.name);

        if (entry.isDirectory()) {
            fs.mkdirSync(memoryEntryPath, { recursive: true });
            return await copyDiskToMemory(fs, realEntryPath, memoryEntryPath, matcher, entryRel);
        } else if (entry.isFile()) {
            const content = await fsRealAsync.readFile(realEntryPath);
            fs.writeFileSync(memoryEntryPath, content);
            return 1;
        }
        return 0;
    });

    const results = await Promise.all(promises);
    return results.reduce((acc, val) => acc + val, 0);
}

/**
 * Copy an in-memory subtree to real disk. Returns the file count. Subtree
 * writes run in parallel; missing directories are mkdir -p'd on demand.
 *
 * Skips writes to content-addressed git object paths that already exist on
 * disk — those files are immutable (0444) and writing them would EACCES.
 */
export async function copyMemoryToDisk(
    fs: MemFs,
    memoryPath: string,
    realPath: string,
    relPath: string = '',
): Promise<number> {
    const entries = fs.readdirSync(memoryPath) as string[];

    const promises = entries.map(async (entry) => {
        const memoryEntryPath = pathNode.posix.join(memoryPath, entry);
        const realEntryPath = pathNode.join(realPath, entry);
        const entryRel = relPath ? pathNode.posix.join(relPath, entry) : entry;

        const stat = fs.statSync(memoryEntryPath);

        if (stat.isDirectory()) {
            const dirExists = await realPathExists(realEntryPath);
            if (!dirExists) {
                await fsRealAsync.mkdir(realEntryPath, { recursive: true });
            }
            return await copyMemoryToDisk(fs, memoryEntryPath, realEntryPath, entryRel);
        } else {
            if (isImmutableObjectPath(entryRel) && await realPathExists(realEntryPath)) {
                return 0;
            }
            const content = fs.readFileSync(memoryEntryPath);
            await fsRealAsync.writeFile(realEntryPath, content);
            return 1;
        }
    });

    const results = await Promise.all(promises);
    return results.reduce((acc, val) => acc + val, 0);
}

/**
 * Incremental disk→memory: walks the real tree and only reads files whose
 * `(size, mtimeMs)` differ from the snapshot. Updates `snapshot` in place
 * with fingerprints of files that were read. Adds every relative file path
 * encountered (even skipped ones) to `seen`, so the caller can detect files
 * deleted on disk by diffing snapshot keys against `seen`.
 *
 * Mirrors `copyDiskToMemory` for ignore semantics: `.git/` is always copied
 * regardless of matcher rules.
 */
export async function copyDiskToMemoryIncremental(
    fs: MemFs,
    realPath: string,
    memoryPath: string,
    matcher: Matcher,
    relPath: string,
    snapshot: Map<string, FileFingerprint>,
    seen: Set<string>,
): Promise<{ read: number; skipped: number }> {
    let entries: Dirent[];
    try {
        entries = await fsRealAsync.readdir(realPath, { withFileTypes: true });
    } catch (err) {
        // Subtree vanished between the parent's readdir and ours — a concurrent
        // git gc / repack / branch update can remove .git/objects/XX/ while we
        // walk. Treat as empty; the caller diffs `seen` against `snapshot` to
        // reconcile the deletion, and a follow-up loadFromDisk picks up the
        // post-mutation state.
        if (isENOENT(err)) return { read: 0, skipped: 0 };
        throw err;
    }

    const results = await Promise.all(entries.map(async (entry) => {
        const entryRel = relPath ? pathNode.posix.join(relPath, entry.name) : entry.name;

        const insideGit = entryRel === '.git' || entryRel.startsWith('.git/');
        if (!insideGit) {
            const probe = entry.isDirectory() ? `${entryRel}/` : entryRel;
            if (matcher.ignores(probe)) return { read: 0, skipped: 0 };
        }

        const realEntryPath = pathNode.join(realPath, entry.name);
        const memoryEntryPath = pathNode.posix.join(memoryPath, entry.name);

        try {
            if (entry.isDirectory()) {
                fs.mkdirSync(memoryEntryPath, { recursive: true });
                return await copyDiskToMemoryIncremental(
                    fs, realEntryPath, memoryEntryPath, matcher, entryRel, snapshot, seen,
                );
            }

            if (entry.isFile()) {
                // stat first, then mark `seen` only on success. A file that
                // ENOENTs here was deleted by an external mutator between our
                // readdir and our stat; leaving it OUT of `seen` lets the
                // caller's deletion sweep drop the stale snapshot+memfs entry.
                const stat = await fsRealAsync.stat(realEntryPath);
                const prior = snapshot.get(entryRel);
                // Fast pre-filter: same size + same mtime ⇒ disk hasn't changed.
                if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
                    seen.add(entryRel);
                    return { read: 0, skipped: 1 };
                }
                const content = await fsRealAsync.readFile(realEntryPath);
                fs.writeFileSync(memoryEntryPath, content);
                snapshot.set(entryRel, {
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    hash: hashBuffer(content),
                });
                seen.add(entryRel);
                return { read: 1, skipped: 0 };
            }

            return { read: 0, skipped: 0 };
        } catch (err) {
            // Same rationale as the top-level readdir guard: a file/dir that
            // vanished mid-walk is not an error — it's a deletion the caller
            // will reconcile via the `seen` diff.
            if (isENOENT(err)) return { read: 0, skipped: 0 };
            throw err;
        }
    }));

    let read = 0;
    let skipped = 0;
    for (const r of results) {
        read += r.read;
        skipped += r.skipped;
    }
    return { read, skipped };
}

/**
 * Incremental memory→disk: walks the in-memory tree and only writes files
 * whose content hash differs from the snapshot (using size as a cheap
 * pre-filter). Updates `snapshot` in place after each write. Adds every
 * relative file path encountered to `seen` so the caller can implement
 * `clean: true` by deleting paths in `snapshot` not in `seen`.
 *
 * Snapshot is treated as authoritative for the on-disk state — we do not
 * stat the destination. That keeps the hot path off slow filesystems
 * (the EFS/NFS use case); the trade-off is that external modifications
 * between flushes are invisible until the user calls loadFromDisk again.
 */
export async function copyMemoryToDiskIncremental(
    fs: MemFs,
    memoryPath: string,
    realPath: string,
    relPath: string,
    snapshot: Map<string, FileFingerprint>,
    seen: Set<string>,
): Promise<{ written: number; skipped: number }> {
    const entries = fs.readdirSync(memoryPath) as string[];

    const results = await Promise.all(entries.map(async (entry) => {
        const memoryEntryPath = pathNode.posix.join(memoryPath, entry);
        const realEntryPath = pathNode.join(realPath, entry);
        const entryRel = relPath ? pathNode.posix.join(relPath, entry) : entry;

        const stat = fs.statSync(memoryEntryPath);

        if (stat.isDirectory()) {
            const dirExists = await realPathExists(realEntryPath);
            if (!dirExists) {
                await fsRealAsync.mkdir(realEntryPath, { recursive: true });
            }
            return await copyMemoryToDiskIncremental(
                fs, memoryEntryPath, realEntryPath, entryRel, snapshot, seen,
            );
        }

        seen.add(entryRel);

        // Content-addressed git objects (.git/objects/XX/YY and pack-*.{pack,idx,…})
        // are immutable. Real git keeps them at mode 0444, so re-writing them
        // races into EACCES; the path IS the content hash, so existence on
        // disk implies the bytes are already correct. Short-circuit BEFORE
        // touching the snapshot so the skip holds even if the snapshot lacks
        // this path or is stale (e.g. memfs got a re-compressed copy from a
        // subsequent git.add()).
        if (isImmutableObjectPath(entryRel)) {
            if (await realPathExists(realEntryPath)) {
                return { written: 0, skipped: 1 };
            }
            // Disk says the immutable object is gone. If we've previously
            // observed it on disk (snapshot.has → true), the file was removed
            // by an external mutator (git gc / repack / prune) and our memfs
            // copy is now a stale ghost. Writing it back resurrects orphaned
            // pack files whose .idx and .pack mtimes drift across flushes —
            // the exact corruption signature observed in prod (memory-git@3.6.1,
            // pods-manager 2026-05-22: unknown object type 0 in pack reads).
            // Drop from memfs+snapshot instead so the next loadFromDisk
            // reconciles against the post-mutation disk state.
            //
            // If the path is NOT in the snapshot, this is a fresh immutable
            // object created in memfs (e.g. isomorphic-git committed and
            // produced a new loose object). Fall through to the write path.
            if (snapshot.has(entryRel)) {
                try {
                    fs.unlinkSync(memoryEntryPath);
                } catch {
                    // Already gone from memfs; snapshot delete below restores consistency.
                }
                snapshot.delete(entryRel);
                return { written: 0, skipped: 1 };
            }
        }

        const content = fs.readFileSync(memoryEntryPath) as Buffer;
        const size = content.length;
        const prior = snapshot.get(entryRel);

        // Size mismatch ⇒ definitely changed; skip hashing.
        if (prior && prior.size === size) {
            const hash = hashBuffer(content);
            if (prior.hash === hash) {
                return { written: 0, skipped: 1 };
            }
            await fsRealAsync.writeFile(realEntryPath, content);
            const newStat = await fsRealAsync.stat(realEntryPath);
            snapshot.set(entryRel, { size, mtimeMs: newStat.mtimeMs, hash });
            return { written: 1, skipped: 0 };
        }

        const hash = hashBuffer(content);
        await fsRealAsync.writeFile(realEntryPath, content);
        const newStat = await fsRealAsync.stat(realEntryPath);
        snapshot.set(entryRel, { size, mtimeMs: newStat.mtimeMs, hash });
        return { written: 1, skipped: 0 };
    }));

    let written = 0;
    let skipped = 0;
    for (const r of results) {
        written += r.written;
        skipped += r.skipped;
    }
    return { written, skipped };
}

/**
 * Lazy disk walk. Builds the in-memory directory skeleton via mkdirSync and
 * records every file path it would have read into `addFile`, without ever
 * opening file contents. The reader function lives in `lazy-fs.ts` and is
 * passed in as a callback so disk-sync stays free of the lazy-state type.
 *
 * Mirrors the ignore semantics of `copyDiskToMemory`: the matcher applies
 * everywhere except inside the repo's own `.git/`, which is always indexed.
 */
export async function indexDiskLazy(
    fs: MemFs,
    realPath: string,
    memoryPath: string,
    matcher: Matcher,
    relPath: string,
    addFile: (memPath: string, realPath: string, size: number, mtimeMs: number) => void,
): Promise<number> {
    const entries = await fsRealAsync.readdir(realPath, { withFileTypes: true });

    const promises = entries.map(async (entry) => {
        const entryRel = relPath ? pathNode.posix.join(relPath, entry.name) : entry.name;

        const insideGit = entryRel === '.git' || entryRel.startsWith('.git/');
        if (!insideGit) {
            const probe = entry.isDirectory() ? `${entryRel}/` : entryRel;
            if (matcher.ignores(probe)) return 0;
        }

        const realEntryPath = pathNode.join(realPath, entry.name);
        const memoryEntryPath = pathNode.posix.join(memoryPath, entry.name);

        if (entry.isDirectory()) {
            fs.mkdirSync(memoryEntryPath, { recursive: true });
            return await indexDiskLazy(fs, realEntryPath, memoryEntryPath, matcher, entryRel, addFile);
        }
        if (entry.isFile()) {
            const stat = await fsRealAsync.stat(realEntryPath);
            addFile(memoryEntryPath, realEntryPath, stat.size, stat.mtimeMs);
            return 1;
        }
        return 0;
    });

    const results = await Promise.all(promises);
    return results.reduce((acc, val) => acc + val, 0);
}

/**
 * Recursively list files under an in-memory directory. By default skips
 * `.git/` so callers don't have to filter; pass `includeGit: true` for the
 * full set.
 *
 * Uses `lstatSync` (not `statSync`) so symlinks are treated as leaves rather
 * than followed: a dangling symlink (e.g. a `node_modules` pointing at a
 * deleted cache) would otherwise make `statSync` throw `ENOENT` and abort the
 * whole walk. Per-entry `ENOENT` is also swallowed to tolerate entries that
 * vanish mid-walk.
 */
export function listFilesRecursive(
    fs: MemFs,
    dir: string,
    base: string = '',
    includeGit: boolean = false,
): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir) as string[];

    for (const entry of entries) {
        const fullPath = pathNode.posix.join(dir, entry);
        const relativePath = base ? pathNode.posix.join(base, entry) : entry;

        let stat;
        try {
            stat = fs.lstatSync(fullPath);
        } catch (err) {
            // Entry disappeared between readdir and lstat — skip it.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
        }

        // Symlinks are leaves: never descend (dangling links don't resolve).
        if (stat.isDirectory()) {
            if (entry === '.git' && !includeGit) continue;
            files.push(...listFilesRecursive(fs, fullPath, relativePath, includeGit));
        } else {
            files.push(relativePath);
        }
    }

    return files;
}
