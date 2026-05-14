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
import pathNode from 'path';
import type { createFsFromVolume } from 'memfs';
import type ignore from 'ignore';

export type MemFs = ReturnType<typeof createFsFromVolume>;
export type Matcher = ReturnType<typeof ignore>;

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
 */
export async function copyMemoryToDisk(
    fs: MemFs,
    memoryPath: string,
    realPath: string,
): Promise<number> {
    const entries = fs.readdirSync(memoryPath) as string[];

    const promises = entries.map(async (entry) => {
        const memoryEntryPath = pathNode.posix.join(memoryPath, entry);
        const realEntryPath = pathNode.join(realPath, entry);

        const stat = fs.statSync(memoryEntryPath);

        if (stat.isDirectory()) {
            const dirExists = await realPathExists(realEntryPath);
            if (!dirExists) {
                await fsRealAsync.mkdir(realEntryPath, { recursive: true });
            }
            return await copyMemoryToDisk(fs, memoryEntryPath, realEntryPath);
        } else {
            const content = fs.readFileSync(memoryEntryPath);
            await fsRealAsync.writeFile(realEntryPath, content);
            return 1;
        }
    });

    const results = await Promise.all(promises);
    return results.reduce((acc, val) => acc + val, 0);
}

/**
 * Recursively list files under an in-memory directory. By default skips
 * `.git/` so callers don't have to filter; pass `includeGit: true` for the
 * full set.
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
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (entry === '.git' && !includeGit) continue;
            files.push(...listFilesRecursive(fs, fullPath, relativePath, includeGit));
        } else {
            files.push(relativePath);
        }
    }

    return files;
}
