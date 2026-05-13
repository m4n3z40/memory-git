import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { createFsFromVolume, Volume } from 'memfs';
import { promises as fsRealAsync } from 'fs';
import pathNode from 'path';
import { parse as shellParse } from 'shell-quote';
import mri from 'mri';
import ignore from 'ignore';

type MemFs = ReturnType<typeof createFsFromVolume>;

// Types
export interface Author {
    name: string;
    email: string;
}

export interface OperationLogEntry {
    timestamp: string;
    operation: string;
    params: Record<string, unknown>;
    success: boolean;
    result: unknown;
    error: string | null;
}

export interface FileStatus {
    filepath: string;
    head: number;
    workdir: number;
    stage: number;
    status: string;
}

export interface CommitInfo {
    sha: string;
    message: string;
    author: string;
    email: string;
    timestamp: string;
}

export interface BranchInfo {
    name: string;
    current: boolean;
}

export interface RemoteInfo {
    remote: string;
    url: string;
}

export interface OperationStats {
    total: number;
    successful: number;
    failed: number;
    byOperation: Record<string, { total: number; successful: number; failed: number }>;
}

export interface RepoInfo {
    initialized: boolean;
    memoryDir: string;
    realDir: string | null;
    currentBranch: string | null;
    branches: BranchInfo[];
    remotes: RemoteInfo[];
    fileCount: number;
    commits: number;
}

export interface MemoryUsage {
    files: number;
    estimatedSizeBytes: number;
    estimatedSizeMB: string;
    operationsLogged: number;
}

export interface LoadFromDiskOptions {
    /** Extra patterns to ignore (added on top of .gitignore). Treated as gitignore-style patterns. */
    ignore?: string[];
    /** Respect .gitignore files in the source tree (default: true). The repo's own .git/ is always loaded regardless. */
    respectGitignore?: boolean;
    /** Also respect nested .gitignore files in subdirectories (default: true; requires respectGitignore). */
    nestedGitignore?: boolean;
}

export interface FlushOptions {
    /** Remove files that don't exist in memory (default: false) */
    clean?: boolean;
}

export interface CloneOptions {
    /** Shallow clone depth */
    depth?: number;
    /** Clone only a single branch */
    singleBranch?: boolean;
    /** Specific branch to check out (-b / --branch) */
    branch?: string;
    /** Skip checking out files after clone */
    noCheckout?: boolean;
    [key: string]: unknown;
}

export interface InitOptions {
    /** Default branch name (default: 'main') */
    defaultBranch?: string;
    /** Create a bare repository */
    bare?: boolean;
}

export interface AddOptions {
    /** Stage all changes including untracked (git add -A) */
    all?: boolean;
    /** Stage only modified/deleted tracked files (git add -u) */
    update?: boolean;
}

export interface CommitOptions {
    /** Replace the tip of the current branch by creating a new commit (git commit --amend) */
    amend?: boolean;
    /** Allow commit with no changes (git commit --allow-empty) */
    allowEmpty?: boolean;
    /** Auto-stage modified/deleted tracked files before committing (git commit -a) */
    all?: boolean;
    /** Override author for this commit only */
    author?: Author;
    /** Override commit timestamp (ms since epoch or Date) */
    date?: Date | number;
}

export interface RemoveOptions {
    /** Remove only from index, keep working file (git rm --cached) */
    cached?: boolean;
}

export interface DeleteBranchOptions {
    /** Force delete even if not merged (git branch -D) */
    force?: boolean;
}

export interface CheckoutOptions {
    /** Create the branch before checking out (git checkout -b) */
    createBranch?: boolean;
    /** Discard local changes (git checkout -f) */
    force?: boolean;
    /** Restrict checkout to specific files (git checkout -- <files>) */
    files?: string[];
}

export interface MergeOptions {
    /** Create a merge commit even when fast-forward is possible (--no-ff) */
    noFastForward?: boolean;
    /** Abort if fast-forward is not possible (--ff-only) */
    fastForwardOnly?: boolean;
    /** Custom merge commit message */
    message?: string;
}

export interface CreateTagOptions {
    /** Ref to tag (commit OID, branch, etc.). Default: 'HEAD' */
    ref?: string;
    /** Create an annotated tag (git tag -a) */
    annotated?: boolean;
    /** Tag message (implies annotated when set) */
    message?: string;
    /** Overwrite existing tag */
    force?: boolean;
}

export interface RenameOptions {
    /** Overwrite destination if it exists (git mv -f) */
    force?: boolean;
}

export interface FetchOptions {
    /** Remote name */
    remote?: string;
    /** Prune remote-tracking refs that no longer exist on remote */
    prune?: boolean;
    /** Fetch all tags */
    tags?: boolean;
    /** Shallow fetch depth */
    depth?: number;
    /** Fetch only a single branch */
    singleBranch?: boolean;
    /** Specific ref to fetch */
    ref?: string;
}

export interface PullOptions {
    /** Remote name */
    remote?: string;
    /** Branch to pull */
    branch?: string;
    /** Refuse to merge unless fast-forward is possible (--ff-only) */
    fastForwardOnly?: boolean;
    /** Only fast-forward (no merge commit) */
    fastForward?: boolean;
}

export interface PushOptions {
    /** Remote name (default: 'origin') */
    remote?: string;
    /** Ref to push (default: current branch) */
    ref?: string;
    /** Remote ref name */
    remoteRef?: string;
    /** Force push (--force) */
    force?: boolean;
    /** Delete the remote ref */
    delete?: boolean;
}

export interface LogOptions {
    /** Maximum number of commits to return */
    depth?: number;
    /** Reference to start from (default: 'HEAD') */
    ref?: string;
    /** Filter by author name/email (substring match) */
    author?: string;
    /** Only include commits since this date (inclusive) */
    since?: Date | number;
    /** Only include commits until this date (inclusive) */
    until?: Date | number;
}

export interface ResolveRefOptions {
    /** Return a short 7-char OID */
    short?: boolean;
    /** Return abbreviated symbolic ref (e.g., 'HEAD' → 'main') */
    abbrevRef?: boolean;
}

export interface DiffOptions {
    /** Compare staged changes against HEAD (git diff --cached) */
    cached?: boolean;
    /** Compare from this ref. If set with toRef, behaves like git diff <from> <to> */
    fromRef?: string;
    /** Compare to this ref. Default: working tree (or HEAD when cached) */
    toRef?: string;
    /** Restrict diff to these paths */
    paths?: string[];
}

export interface ShowResult {
    commit: CommitInfo;
    parents: string[];
    changes: ChangedFile[];
}

export interface MergeResult {
    oid?: string;
    alreadyMerged?: boolean;
    fastForward?: boolean;
}

export interface DiffEntry {
    filepath: string;
    status: string;
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOptions {
    mode?: ResetMode;
    /** Restrict reset to these paths (git reset HEAD -- <paths>). Mode is ignored when present. */
    paths?: string[];
}

export interface TagRef {
    tagName: string;
    commitOid: string;
}

export interface ChangedFile {
    filepath: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface RevListOptions {
    all?: boolean;
    reverse?: boolean;
    maxCount?: number;
    ref?: string;
}

interface StashedFile {
    filepath: string;
    content?: Buffer | string;
    wasNew?: boolean;
    deleted?: boolean;
}

/**
 * MemoryGit - In-memory Git implementation
 * 
 * Loads the project into memory, executes all git operations in memory,
 * and syncs to disk only when flush() is called.
 * 
 * All real disk operations use async versions to not block the Node.js event loop.
 */
export class MemoryGit {
    /** Instance name */
    readonly name: string;
    /** Memory filesystem */
    readonly fs: MemFs;
    /** Volume instance */
    readonly vol: InstanceType<typeof Volume>;
    /** In-memory repository directory */
    readonly dir: string = '/repo';
    /** Real disk directory (if loaded from disk) */
    realDir: string | null = null;
    /** Whether the repository is initialized */
    isInitialized: boolean = false;
    /** Author information for commits */
    author: Author = { name: 'Memory Git', email: 'memory@git.local' };
    
    private operations: OperationLogEntry[] = [];
    private _stash: StashedFile[][] = [];
    /**
     * Workdir paths known to have been written/deleted since the last add/sync.
     * Used as a fast-path for `add('.')` / `add({all|update})` so we don't re-hash
     * every tracked file on each call (which is the main perf cost vs git CLI).
     * Synced on: explicit add(paths), checkout, reset(hard), merge, stash, clone.
     */
    private _dirtyFiles: Set<string> = new Set();

    /**
     * Creates a new MemoryGit instance
     * @param name - Unique name to identify the instance
     */
    constructor(name: string = 'memory-git') {
        this.name = name;
        this.vol = new Volume();
        this.fs = createFsFromVolume(this.vol);
    }

    /**
     * Logs an operation
     * @private
     */
    private _logOperation(
        operation: string, 
        params: Record<string, unknown>, 
        result: unknown = null, 
        error: Error | null = null
    ): OperationLogEntry {
        const entry: OperationLogEntry = {
            timestamp: new Date().toISOString(),
            operation,
            params: this._sanitizeParams(params),
            success: error === null,
            result: result,
            error: error ? error.message : null
        };
        this.operations.push(entry);
        return entry;
    }

    /**
     * Removes large data from params for logging
     * @private
     */
    private _sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
        const sanitized = { ...params };
        if (sanitized.content && typeof sanitized.content === 'string' && sanitized.content.length > 100) {
            sanitized.content = `[${sanitized.content.length} bytes]`;
        }
        if (Buffer.isBuffer(sanitized.content)) {
            sanitized.content = `[Buffer: ${sanitized.content.length} bytes]`;
        }
        return sanitized;
    }

    /**
     * Resolves a ref or short OID to a full OID. Accepts symbolic refs (HEAD, branch, tag) or hex hashes.
     * @private
     */
    private async _resolveAny(ref: string): Promise<string> {
        try {
            return await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
        } catch (e) {
            if (/^[0-9a-f]{4,40}$/i.test(ref)) {
                return await git.expandOid({ fs: this.fs, dir: this.dir, oid: ref });
            }
            throw e;
        }
    }

    /**
     * Checks if a path exists on real disk (async)
     * @private
     */
    private async _realPathExists(filepath: string): Promise<boolean> {
        try {
            await fsRealAsync.access(filepath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Sets the author for commits
     * @param name - Author name
     * @param email - Author email
     */
    setAuthor(name: string, email: string): void {
        this.author = { name, email };
        this._logOperation('setAuthor', { name, email });
    }

    /**
     * Gets or sets a git config value (git config <key> [<value>])
     * Special-cases user.name / user.email to also update this.author
     * @param key - Config key (e.g., 'user.name', 'core.bare')
     * @param value - Value to set; omit to read
     * @returns The value (when reading) or undefined (when writing)
     */
    async config(key: string, value?: string): Promise<string | undefined> {
        try {
            if (value === undefined) {
                const v = await git.getConfig({ fs: this.fs, dir: this.dir, path: key });
                this._logOperation('config', { key }, { success: true, value: v });
                return v;
            }
            await git.setConfig({ fs: this.fs, dir: this.dir, path: key, value });
            if (key === 'user.name') this.author = { ...this.author, name: value };
            else if (key === 'user.email') this.author = { ...this.author, email: value };
            this._logOperation('config', { key, value }, { success: true });
            return undefined;
        } catch (error) {
            this._logOperation('config', { key, value }, null, error as Error);
            throw error;
        }
    }

    /**
     * Initializes a new repository in memory
     * @param options - Init options (defaultBranch, bare)
     */
    async init(options: InitOptions = {}): Promise<boolean> {
        const defaultBranch = options.defaultBranch ?? 'main';
        const bare = options.bare ?? false;
        try {
            this.fs.mkdirSync(this.dir, { recursive: true });
            await git.init({ fs: this.fs, dir: this.dir, defaultBranch, bare });
            this.isInitialized = true;
            this._logOperation('init', { dir: this.dir, defaultBranch, bare }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('init', { dir: this.dir, defaultBranch, bare }, null, error as Error);
            throw error;
        }
    }

    /**
     * Loads an existing repository from disk to memory
     * @param sourcePath - Path to the repository on disk
     * @param options - Loading options
     * @returns Number of files loaded
     */
    async loadFromDisk(sourcePath: string, options: LoadFromDiskOptions = {}): Promise<number> {
        try {
            this.realDir = pathNode.resolve(sourcePath);
            const respectGitignore = options.respectGitignore !== false;
            const nestedGitignore = options.nestedGitignore !== false;
            const explicitIgnore = options.ignore ?? [];

            // Build the matcher. .gitignore semantics: globs, negation, anchored paths.
            const matcher = ignore();
            matcher.add(explicitIgnore);

            if (respectGitignore) {
                const patterns = await this._collectGitignorePatterns(this.realDir, nestedGitignore);
                if (patterns.length > 0) matcher.add(patterns);
            }

            // Create base directory in memory
            this.fs.mkdirSync(this.dir, { recursive: true });

            // Copy recursively from disk to memory (async)
            const fileCount = await this._copyToMemoryAsync(this.realDir, this.dir, matcher, '');

            // After load, every working-tree file is unsynced with the (likely empty) index.
            // Seed the dirty set so `add('.')` can pick them all up without rescanning.
            for (const f of this._listFilesRecursive(this.dir)) {
                this._dirtyFiles.add(f);
            }

            this.isInitialized = true;
            this._logOperation('loadFromDisk', {
                sourcePath: this.realDir,
                respectGitignore,
                nestedGitignore,
                explicitIgnore
            }, { success: true, filesLoaded: fileCount });
            return fileCount;
        } catch (error) {
            this._logOperation('loadFromDisk', { sourcePath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Walks the source tree and collects all .gitignore patterns (with prefixes for nested files).
     * @private
     */
    private async _collectGitignorePatterns(root: string, nested: boolean): Promise<string[]> {
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
                        // Handle leading `!` (negation) and `/` (anchored) correctly.
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
                let entries: import('fs').Dirent[];
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
     * Copies files from real disk to memory filesystem (async)
     * @private
     */
    private async _copyToMemoryAsync(
        realPath: string,
        memoryPath: string,
        matcher: ReturnType<typeof ignore>,
        relPath: string
    ): Promise<number> {
        const entries = await fsRealAsync.readdir(realPath, { withFileTypes: true });

        const promises = entries.map(async (entry) => {
            const entryRel = relPath ? pathNode.posix.join(relPath, entry.name) : entry.name;

            // Always load the repo's own .git/ — that's the git database we need.
            // The exception covers the .git directory itself AND anything beneath it.
            const insideGit = entryRel === '.git' || entryRel.startsWith('.git/');
            if (!insideGit) {
                // ignore() requires a trailing slash on directories to apply directory-only rules
                const probe = entry.isDirectory() ? `${entryRel}/` : entryRel;
                if (matcher.ignores(probe)) return 0;
            }

            const realEntryPath = pathNode.join(realPath, entry.name);
            const memoryEntryPath = pathNode.posix.join(memoryPath, entry.name);

            if (entry.isDirectory()) {
                this.fs.mkdirSync(memoryEntryPath, { recursive: true });
                return await this._copyToMemoryAsync(realEntryPath, memoryEntryPath, matcher, entryRel);
            } else if (entry.isFile()) {
                const content = await fsRealAsync.readFile(realEntryPath);
                this.fs.writeFileSync(memoryEntryPath, content);
                return 1;
            }
            return 0;
        });

        const results = await Promise.all(promises);
        return results.reduce((acc, val) => acc + val, 0);
    }

    /**
     * Counts files in a directory in memory
     * @private
     */
    private _countFiles(dir: string): number {
        let count = 0;
        const entries = this.fs.readdirSync(dir) as string[];
        
        for (const entry of entries) {
            const fullPath = pathNode.posix.join(dir, entry);
            const stat = this.fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                count += this._countFiles(fullPath);
            } else {
                count++;
            }
        }
        return count;
    }

    /**
     * Writes a file to the in-memory repository
     * @param filepath - Relative file path
     * @param content - File content
     */
    async writeFile(filepath: string, content: string | Buffer): Promise<boolean> {
        try {
            const fullPath = pathNode.posix.join(this.dir, filepath);
            const dir = pathNode.posix.dirname(fullPath);

            // Create directories if needed
            this.fs.mkdirSync(dir, { recursive: true });
            this.fs.writeFileSync(fullPath, content);
            this._dirtyFiles.add(filepath);

            this._logOperation('writeFile', { filepath, content }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('writeFile', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Reads a file from the in-memory repository
     * @param filepath - Relative file path
     * @returns File content
     */
    async readFile(filepath: string): Promise<string> {
        try {
            const fullPath = pathNode.posix.join(this.dir, filepath);
            const content = this.fs.readFileSync(fullPath, 'utf8') as string;
            this._logOperation('readFile', { filepath }, { success: true, size: content.length });
            return content;
        } catch (error) {
            this._logOperation('readFile', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Checks if a file exists
     * @param filepath - Relative file path
     */
    async fileExists(filepath: string): Promise<boolean> {
        try {
            const fullPath = pathNode.posix.join(this.dir, filepath);
            return this.fs.existsSync(fullPath);
        } catch {
            return false;
        }
    }

    /**
     * Deletes a file from the in-memory repository
     * @param filepath - Relative file path
     */
    async deleteFile(filepath: string): Promise<boolean> {
        try {
            const fullPath = pathNode.posix.join(this.dir, filepath);
            this.fs.unlinkSync(fullPath);
            this._dirtyFiles.add(filepath);
            this._logOperation('deleteFile', { filepath }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteFile', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Adds file(s) to the staging area
     * @param filepath - Relative file path(s), '.' for all, or [] when using options.all
     * @param options - {all} stages all changes (incl. untracked); {update} stages only tracked changes
     */
    async add(filepath: string | string[] = [], options: AddOptions = {}): Promise<boolean> {
        try {
            const wantsAll = options.all || filepath === '.' || filepath === '-A';
            const wantsUpdate = options.update;
            let files: string[];

            if (wantsAll || wantsUpdate) {
                // Fast path: process only files we've touched since the last sync.
                // We track these in `_dirtyFiles` (populated by writeFile/deleteFile/rename
                // /stashPop/loadFromDisk) so we don't have to rescan the whole workdir.
                if (wantsUpdate) {
                    // Only tracked files (modifications/deletions, no untracked)
                    let trackedFiles: string[] = [];
                    try {
                        trackedFiles = await git.listFiles({ fs: this.fs, dir: this.dir, ref: 'HEAD' });
                    } catch {
                        // No HEAD yet
                    }
                    const tracked = new Set(trackedFiles);
                    files = [...this._dirtyFiles].filter(f => tracked.has(f));
                } else {
                    files = [...this._dirtyFiles];
                }
            } else {
                files = Array.isArray(filepath) ? filepath : [filepath];
            }

            // Split into present (to add) and missing (to remove from index)
            const present: string[] = [];
            const absent: string[] = [];
            for (const file of files) {
                const fullPath = pathNode.posix.join(this.dir, file);
                (this.fs.existsSync(fullPath) ? present : absent).push(file);
            }

            // git.add accepts an array — one batched call is much faster than N awaits
            if (present.length > 0) {
                await git.add({ fs: this.fs, dir: this.dir, filepath: present });
            }
            for (const file of absent) {
                try {
                    await git.remove({ fs: this.fs, dir: this.dir, filepath: file });
                } catch {
                    // File wasn't tracked either; nothing to do
                }
            }

            // Clear processed entries from the dirty set
            for (const f of files) this._dirtyFiles.delete(f);

            this._logOperation('add', { filepath: files, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('add', { filepath, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Removes file(s) from the staging area and (optionally) working tree
     * @param filepath - Relative file path
     * @param options - {cached: true} removes only from index, keeping the working file (git rm --cached)
     */
    async remove(filepath: string, options: RemoveOptions = {}): Promise<boolean> {
        try {
            await git.remove({ fs: this.fs, dir: this.dir, filepath });

            if (!options.cached) {
                const fullPath = pathNode.posix.join(this.dir, filepath);
                if (this.fs.existsSync(fullPath)) {
                    this.fs.unlinkSync(fullPath);
                }
            }
            this._dirtyFiles.delete(filepath);

            this._logOperation('remove', { filepath, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('remove', { filepath, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Creates a commit with staged changes
     * @param message - Commit message (when amending, omit/empty to reuse previous message)
     * @param options - Commit options
     * @returns SHA of the created commit
     */
    async commit(message: string = '', options: CommitOptions = {}): Promise<string> {
        try {
            // Auto-stage tracked changes (git commit -a) — delegate to add({update}) which
            // walks workdir directly to avoid the memfs stat-cache miss in statusMatrix.
            if (options.all) {
                await this.add([], { update: true });
            }

            const author: Author & { timestamp?: number; timezoneOffset?: number } =
                { ...(options.author ?? this.author) };

            if (options.date !== undefined) {
                const ts = options.date instanceof Date ? options.date.getTime() : options.date;
                author.timestamp = Math.floor(ts / 1000);
                author.timezoneOffset = new Date(ts).getTimezoneOffset();
            }

            if (!options.amend && !options.allowEmpty) {
                // git CLI refuses empty commits by default; isomorphic-git allows them, so guard
                let parentExists = true;
                try {
                    await git.resolveRef({ fs: this.fs, dir: this.dir, ref: 'HEAD' });
                } catch {
                    parentExists = false;
                }
                if (parentExists) {
                    const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
                    const hasStaged = matrix.some(([, head, , stage]) => head !== stage);
                    if (!hasStaged) {
                        throw new Error('nothing to commit, working tree clean');
                    }
                }
            }

            const sha = await git.commit({
                fs: this.fs,
                dir: this.dir,
                message,
                author,
                amend: options.amend
            });

            this._logOperation('commit', { message, options }, { success: true, sha });
            return sha;
        } catch (error) {
            this._logOperation('commit', { message, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Gets repository status
     * @returns List of files with their status
     */
    async status(): Promise<FileStatus[]> {
        try {
            const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
            
            const result = statusMatrix.map(([filepath, head, workdir, stage]) => ({
                filepath: filepath as string,
                head: head as number,
                workdir: workdir as number,
                stage: stage as number,
                status: this._getStatusText(head as number, workdir as number, stage as number)
            }));
            
            this._logOperation('status', {}, { success: true, files: result.length });
            return result;
        } catch (error) {
            this._logOperation('status', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Converts numeric status to readable text
     * @private
     */
    private _getStatusText(head: number, workdir: number, stage: number): string {
        if (head === 0 && workdir === 2 && stage === 0) return 'new, untracked';
        if (head === 0 && workdir === 2 && stage === 2) return 'added, staged';
        if (head === 0 && workdir === 2 && stage === 3) return 'added, staged, with unstaged changes';
        if (head === 1 && workdir === 1 && stage === 1) return 'unmodified';
        if (head === 1 && workdir === 2 && stage === 1) return 'modified, unstaged';
        if (head === 1 && workdir === 2 && stage === 2) return 'modified, staged';
        if (head === 1 && workdir === 2 && stage === 3) return 'modified, staged, with unstaged changes';
        if (head === 1 && workdir === 0 && stage === 0) return 'deleted, unstaged';
        if (head === 1 && workdir === 0 && stage === 1) return 'deleted, staged';
        if (head === 1 && workdir === 1 && stage === 0) return 'deleted, staged';
        return `unknown (${head}, ${workdir}, ${stage})`;
    }

    /**
     * Gets commit log
     * @param depthOrOptions - Number of commits (legacy) or LogOptions
     * @returns List of commits
     */
    async log(depthOrOptions: number | LogOptions = 10): Promise<CommitInfo[]> {
        const options: LogOptions =
            typeof depthOrOptions === 'number' ? { depth: depthOrOptions } : depthOrOptions;
        const depth = options.depth;
        const ref = options.ref ?? 'HEAD';

        try {
            const commits = await git.log({ fs: this.fs, dir: this.dir, depth, ref });

            const sinceMs = options.since instanceof Date ? options.since.getTime() :
                            typeof options.since === 'number' ? options.since : undefined;
            const untilMs = options.until instanceof Date ? options.until.getTime() :
                            typeof options.until === 'number' ? options.until : undefined;
            const authorFilter = options.author?.toLowerCase();

            const result = commits
                .filter(c => {
                    const ts = c.commit.author.timestamp * 1000;
                    if (sinceMs !== undefined && ts < sinceMs) return false;
                    if (untilMs !== undefined && ts > untilMs) return false;
                    if (authorFilter) {
                        const a = c.commit.author;
                        const hay = `${a.name} ${a.email}`.toLowerCase();
                        if (!hay.includes(authorFilter)) return false;
                    }
                    return true;
                })
                .map(commit => ({
                    sha: commit.oid,
                    message: commit.commit.message,
                    author: commit.commit.author.name,
                    email: commit.commit.author.email,
                    timestamp: new Date(commit.commit.author.timestamp * 1000).toISOString()
                }));

            this._logOperation('log', { options }, { success: true, commits: result.length });
            return result;
        } catch (error) {
            this._logOperation('log', { options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Creates a new branch
     * @param branchName - Branch name
     */
    async createBranch(branchName: string): Promise<boolean> {
        try {
            await git.branch({ fs: this.fs, dir: this.dir, ref: branchName });
            this._logOperation('createBranch', { branchName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('createBranch', { branchName }, null, error as Error);
            throw error;
        }
    }

    /**
     * Deletes a branch
     * @param branchName - Branch name
     * @param options - {force: true} skips the merged-into-current check (git branch -D)
     */
    async deleteBranch(branchName: string, options: DeleteBranchOptions = {}): Promise<boolean> {
        try {
            if (!options.force) {
                const current = await git.currentBranch({ fs: this.fs, dir: this.dir });
                if (current && current !== branchName) {
                    try {
                        const targetOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: branchName });
                        const currentOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: current });
                        const merged = targetOid === currentOid || await git.isDescendent({
                            fs: this.fs,
                            dir: this.dir,
                            oid: currentOid,
                            ancestor: targetOid,
                            depth: -1
                        });
                        if (!merged) {
                            throw new Error(`The branch '${branchName}' is not fully merged. Use force to delete it.`);
                        }
                    } catch (e) {
                        if ((e as Error).message.includes('not fully merged')) throw e;
                        // If we can't resolve refs, fall through and let deleteBranch surface the error
                    }
                }
            }
            await git.deleteBranch({ fs: this.fs, dir: this.dir, ref: branchName });
            this._logOperation('deleteBranch', { branchName, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteBranch', { branchName, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Renames a branch (git branch -m <old> <new>)
     * @param oldName - Current branch name
     * @param newName - New branch name
     */
    async renameBranch(oldName: string, newName: string): Promise<boolean> {
        try {
            await git.renameBranch({ fs: this.fs, dir: this.dir, ref: newName, oldref: oldName });
            this._logOperation('renameBranch', { oldName, newName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('renameBranch', { oldName, newName }, null, error as Error);
            throw error;
        }
    }

    /**
     * Switches to a branch/ref or restores files
     * @param branchName - Branch, tag, or commit ref
     * @param options - {createBranch} like git checkout -b; {force} discard local changes; {files} restrict to paths
     */
    async checkout(branchName: string, options: CheckoutOptions = {}): Promise<boolean> {
        try {
            if (options.createBranch) {
                await git.branch({ fs: this.fs, dir: this.dir, ref: branchName, checkout: false });
            }
            await git.checkout({
                fs: this.fs,
                dir: this.dir,
                ref: branchName,
                force: options.force,
                filepaths: options.files
            });
            // Workdir was rewritten from the target tree — anything we'd tracked as dirty
            // is gone (unless this was a path-restricted checkout, but conservatively clear all).
            this._dirtyFiles.clear();
            this._logOperation('checkout', { branchName, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('checkout', { branchName, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists all branches
     * @returns List of branches
     */
    async listBranches(): Promise<BranchInfo[]> {
        try {
            const branches = await git.listBranches({ fs: this.fs, dir: this.dir });
            const current = await git.currentBranch({ fs: this.fs, dir: this.dir });
            
            const result = branches.map(branch => ({
                name: branch,
                current: branch === current
            }));
            
            this._logOperation('listBranches', {}, { success: true, branches: result });
            return result;
        } catch (error) {
            this._logOperation('listBranches', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Gets the current branch
     * @returns Current branch name
     */
    async currentBranch(): Promise<string | undefined> {
        try {
            const branch = await git.currentBranch({ fs: this.fs, dir: this.dir });
            this._logOperation('currentBranch', {}, { success: true, branch });
            return branch || undefined;
        } catch (error) {
            this._logOperation('currentBranch', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Merges a branch into the current branch
     * @param theirBranch - Branch name to merge
     * @param options - Merge options
     */
    async merge(theirBranch: string, options: MergeOptions = {}): Promise<MergeResult> {
        try {
            const result = await git.merge({
                fs: this.fs,
                dir: this.dir,
                theirs: theirBranch,
                author: this.author,
                fastForward: options.noFastForward ? false : undefined,
                fastForwardOnly: options.fastForwardOnly,
                message: options.message
            });
            // Merge rewrote workdir and index to the merge result
            this._dirtyFiles.clear();

            this._logOperation('merge', { theirBranch, options }, { success: true, ...result });
            return result;
        } catch (error) {
            this._logOperation('merge', { theirBranch, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Adds a remote
     * @param remoteName - Remote name
     * @param url - Remote URL
     */
    async addRemote(remoteName: string, url: string): Promise<boolean> {
        try {
            await git.addRemote({ fs: this.fs, dir: this.dir, remote: remoteName, url });
            this._logOperation('addRemote', { remoteName, url }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('addRemote', { remoteName, url }, null, error as Error);
            throw error;
        }
    }

    /**
     * Removes a remote
     * @param remoteName - Remote name
     */
    async deleteRemote(remoteName: string): Promise<boolean> {
        try {
            await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: remoteName });
            this._logOperation('deleteRemote', { remoteName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteRemote', { remoteName }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists configured remotes
     * @returns List of remotes
     */
    async listRemotes(): Promise<RemoteInfo[]> {
        try {
            const remotes = await git.listRemotes({ fs: this.fs, dir: this.dir });
            this._logOperation('listRemotes', {}, { success: true, remotes });
            return remotes;
        } catch (error) {
            this._logOperation('listRemotes', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Creates a tag (lightweight or annotated)
     * @param tagName - Tag name
     * @param refOrOptions - Ref to tag (legacy positional) OR CreateTagOptions
     * @param options - When 2nd arg is a string ref, options can be passed as the 3rd arg
     */
    async createTag(
        tagName: string,
        refOrOptions: string | CreateTagOptions = 'HEAD',
        options: CreateTagOptions = {}
    ): Promise<boolean> {
        const opts: CreateTagOptions =
            typeof refOrOptions === 'string'
                ? { ref: refOrOptions, ...options }
                : refOrOptions;
        const ref = opts.ref ?? 'HEAD';
        const annotated = opts.annotated || opts.message !== undefined;

        try {
            if (opts.force) {
                const existing = await git.listTags({ fs: this.fs, dir: this.dir });
                if (existing.includes(tagName)) {
                    await git.deleteRef({ fs: this.fs, dir: this.dir, ref: `refs/tags/${tagName}` });
                }
            }

            if (annotated) {
                const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
                await git.annotatedTag({
                    fs: this.fs,
                    dir: this.dir,
                    ref: tagName,
                    object: oid,
                    message: opts.message ?? tagName,
                    tagger: this.author
                });
            } else {
                await git.tag({ fs: this.fs, dir: this.dir, ref: tagName, object: ref });
            }

            this._logOperation('createTag', { tagName, ref, options: opts }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('createTag', { tagName, ref, options: opts }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists all tags
     * @returns List of tags
     */
    async listTags(): Promise<string[]> {
        try {
            const tags = await git.listTags({ fs: this.fs, dir: this.dir });
            this._logOperation('listTags', {}, { success: true, tags });
            return tags;
        } catch (error) {
            this._logOperation('listTags', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Resolves any ref (HEAD, branch, tag, short hash) to a full OID
     * Equivalent to git rev-parse
     * @param ref - Reference to resolve (default: 'HEAD')
     * @param options - Options (short: return first 7 chars)
     * @returns Full OID (or 7-char short OID)
     */
    async resolveRef(ref: string = 'HEAD', options?: ResolveRefOptions): Promise<string> {
        try {
            if (options?.abbrevRef) {
                // For symbolic refs (HEAD), resolve to branch name without prefix
                if (ref === 'HEAD') {
                    const branch = await git.currentBranch({ fs: this.fs, dir: this.dir });
                    if (branch) {
                        this._logOperation('resolveRef', { ref, options }, { success: true, abbrev: branch });
                        return branch;
                    }
                }
                // For other refs, strip 'refs/heads/' / 'refs/tags/' prefix
                const stripped = ref.replace(/^refs\/(heads|tags|remotes)\//, '');
                this._logOperation('resolveRef', { ref, options }, { success: true, abbrev: stripped });
                return stripped;
            }
            const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
            const result = options?.short ? oid.slice(0, 7) : oid;
            this._logOperation('resolveRef', { ref, options }, { success: true, oid: result });
            return result;
        } catch (error) {
            this._logOperation('resolveRef', { ref, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Deletes a tag
     * Equivalent to git tag -d <tagName>
     * @param tagName - Tag name to delete
     */
    async deleteTag(tagName: string): Promise<boolean> {
        try {
            const tags = await git.listTags({ fs: this.fs, dir: this.dir });
            if (!tags.includes(tagName)) {
                throw new Error(`Tag not found: ${tagName}`);
            }
            await git.deleteRef({ fs: this.fs, dir: this.dir, ref: `refs/tags/${tagName}` });
            this._logOperation('deleteTag', { tagName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteTag', { tagName }, null, error as Error);
            throw error;
        }
    }

    /**
     * Resets the current branch to the specified ref
     * Equivalent to git reset [--soft | --mixed | --hard] <ref>
     * @param ref - Reference to reset to (default: 'HEAD')
     * @param options - Reset options (mode: 'soft' | 'mixed' | 'hard', default: 'mixed')
     * @returns OID of the target commit
     */
    async reset(ref: string = 'HEAD', options?: ResetOptions): Promise<string> {
        const mode = options?.mode ?? 'mixed';
        try {
            const oid = await this._resolveAny(ref);

            // File-level reset (git reset HEAD <paths>): unstage only those paths
            if (options?.paths && options.paths.length > 0) {
                for (const filepath of options.paths) {
                    try {
                        await git.resetIndex({ fs: this.fs, dir: this.dir, filepath, ref: oid });
                    } catch {
                        // Skip files that can't be processed
                    }
                }
                this._logOperation('reset', { ref, paths: options.paths }, { success: true, oid });
                return oid;
            }

            const branch = await git.currentBranch({ fs: this.fs, dir: this.dir });

            if (branch) {
                await git.writeRef({
                    fs: this.fs,
                    dir: this.dir,
                    ref: `refs/heads/${branch}`,
                    value: oid,
                    force: true
                });
            }

            if (mode === 'hard') {
                await git.checkout({ fs: this.fs, dir: this.dir, ref: oid, force: true });
                // Workdir was rewritten — anything we'd flagged as dirty is gone
                this._dirtyFiles.clear();
            } else if (mode === 'mixed') {
                // Update index to match the target commit tree, leave working tree untouched
                const files = await git.listFiles({ fs: this.fs, dir: this.dir, ref: oid });
                for (const filepath of files) {
                    try {
                        await git.resetIndex({ fs: this.fs, dir: this.dir, filepath });
                    } catch {
                        // Skip files that can't be processed
                    }
                }
                // Also reset any staged files not in the target commit
                const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
                for (const [filepath, head, , stage] of statusMatrix) {
                    if (stage !== head) {
                        try {
                            await git.resetIndex({ fs: this.fs, dir: this.dir, filepath: filepath as string });
                        } catch {
                            // Skip
                        }
                    }
                }
            }
            // soft: only branch pointer was moved, index and working tree unchanged

            this._logOperation('reset', { ref, mode }, { success: true, oid });
            return oid;
        } catch (error) {
            this._logOperation('reset', { ref, mode }, null, error as Error);
            throw error;
        }
    }

    /**
     * Renames a file and stages the change (equivalent to git mv)
     * Staging is automatic, consistent with real git mv behavior
     * @param oldPath - Current file path (relative)
     * @param newPath - New file path (relative)
     */
    async rename(oldPath: string, newPath: string, options: RenameOptions = {}): Promise<boolean> {
        try {
            const fullOldPath = pathNode.posix.join(this.dir, oldPath);
            const fullNewPath = pathNode.posix.join(this.dir, newPath);

            if (this.fs.existsSync(fullNewPath) && !options.force) {
                throw new Error(`destination '${newPath}' already exists`);
            }

            const content = this.fs.readFileSync(fullOldPath);

            const newDir = pathNode.posix.dirname(fullNewPath);
            this.fs.mkdirSync(newDir, { recursive: true });

            this.fs.writeFileSync(fullNewPath, content as Buffer);
            this.fs.unlinkSync(fullOldPath);

            await git.remove({ fs: this.fs, dir: this.dir, filepath: oldPath });
            await git.add({ fs: this.fs, dir: this.dir, filepath: newPath });
            this._dirtyFiles.delete(oldPath);
            this._dirtyFiles.delete(newPath);

            this._logOperation('rename', { oldPath, newPath, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('rename', { oldPath, newPath, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Returns the tag that points exactly to the specified ref (equivalent to git describe --exact-match --tags)
     * @param ref - Reference to check (default: 'HEAD')
     * @returns Tag name or null if no tag points to that commit
     */
    async describeExact(ref: string = 'HEAD'): Promise<string | null> {
        try {
            const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
            const tagRefs = await this.showTagRefs();
            const match = tagRefs.find(t => t.commitOid === oid);
            const result = match?.tagName ?? null;
            this._logOperation('describeExact', { ref }, { success: true, tag: result });
            return result;
        } catch (error) {
            this._logOperation('describeExact', { ref }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists all tag references resolving annotated tags to their target commit OID
     * Equivalent to git show-ref --tags -d
     * @returns List of tag references with their commit OIDs
     */
    async showTagRefs(): Promise<TagRef[]> {
        try {
            const tags = await git.listTags({ fs: this.fs, dir: this.dir });
            const result: TagRef[] = [];

            for (const tagName of tags) {
                const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: `refs/tags/${tagName}` });
                let commitOid = oid;
                try {
                    const obj = await git.readTag({ fs: this.fs, dir: this.dir, oid });
                    commitOid = obj.tag.object;
                } catch {
                    // Lightweight tag — oid is already the commit
                }
                result.push({ tagName, commitOid });
            }

            this._logOperation('showTagRefs', {}, { success: true, count: result.length });
            return result;
        } catch (error) {
            this._logOperation('showTagRefs', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists all tracked files at a given ref (equivalent to git ls-tree -r --name-only)
     * @param ref - Reference (default: 'HEAD')
     * @returns List of tracked file paths
     */
    async listTrackedFiles(ref: string = 'HEAD'): Promise<string[]> {
        try {
            const files = await git.listFiles({ fs: this.fs, dir: this.dir, ref });
            this._logOperation('listTrackedFiles', { ref }, { success: true, count: files.length });
            return files;
        } catch (error) {
            this._logOperation('listTrackedFiles', { ref }, null, error as Error);
            throw error;
        }
    }

    /**
     * Returns the list of files changed between two refs
     * Uses git.walk to compare tree objects
     * @param fromRef - Base reference for comparison
     * @param toRef - Target reference (default: 'HEAD')
     * @param options - Filter options
     * @returns List of changed files with their status
     */
    async getChangedFiles(
        fromRef: string,
        toRef: string = 'HEAD',
        options?: { filter?: Array<'added' | 'modified' | 'deleted' | 'renamed'> }
    ): Promise<ChangedFile[]> {
        try {
            const fromOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: fromRef });
            const toOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: toRef });

            const changes: ChangedFile[] = [];

            await git.walk({
                fs: this.fs,
                dir: this.dir,
                trees: [git.TREE({ ref: fromOid }), git.TREE({ ref: toOid })],
                map: async (filepath, [fromEntry, toEntry]) => {
                    if (filepath === '.') return;

                    const fromType = fromEntry ? await fromEntry.type() : null;
                    const toType = toEntry ? await toEntry.type() : null;

                    // Skip directories
                    if (fromType === 'tree' || toType === 'tree') return;

                    if (!fromEntry && toEntry) {
                        changes.push({ filepath, status: 'added' });
                    } else if (fromEntry && !toEntry) {
                        changes.push({ filepath, status: 'deleted' });
                    } else if (fromEntry && toEntry) {
                        const fromOidEntry = await fromEntry.oid();
                        const toOidEntry = await toEntry.oid();
                        if (fromOidEntry !== toOidEntry) {
                            changes.push({ filepath, status: 'modified' });
                        }
                    }
                }
            });

            const result = options?.filter
                ? changes.filter(c => options.filter!.includes(c.status))
                : changes;

            this._logOperation('getChangedFiles', { fromRef, toRef, options }, { success: true, count: result.length });
            return result;
        } catch (error) {
            this._logOperation('getChangedFiles', { fromRef, toRef, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Shows a commit: metadata + files changed against its first parent
     * Equivalent to git show <ref>
     * @param ref - Commit ref (default: 'HEAD')
     */
    async show(ref: string = 'HEAD'): Promise<ShowResult> {
        try {
            const oid = await this._resolveAny(ref);
            const obj = await git.readCommit({ fs: this.fs, dir: this.dir, oid });
            const commit: CommitInfo = {
                sha: obj.oid,
                message: obj.commit.message,
                author: obj.commit.author.name,
                email: obj.commit.author.email,
                timestamp: new Date(obj.commit.author.timestamp * 1000).toISOString()
            };

            let changes: ChangedFile[] = [];
            if (obj.commit.parent && obj.commit.parent.length > 0) {
                changes = await this.getChangedFiles(obj.commit.parent[0], oid);
            } else {
                // Root commit — every file is added
                const files = await git.listFiles({ fs: this.fs, dir: this.dir, ref: oid });
                changes = files.map(filepath => ({ filepath, status: 'added' as const }));
            }

            const result: ShowResult = { commit, parents: obj.commit.parent ?? [], changes };
            this._logOperation('show', { ref }, { success: true, sha: oid });
            return result;
        } catch (error) {
            this._logOperation('show', { ref }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists commit OIDs (equivalent to git rev-list)
     * @param options - Options for filtering and ordering
     * @returns List of commit OIDs
     */
    async revList(options?: RevListOptions): Promise<string[]> {
        try {
            const ref = options?.ref ?? 'HEAD';

            let oids: string[] = [];

            if (options?.all) {
                const branches = await git.listBranches({ fs: this.fs, dir: this.dir });
                const seen = new Set<string>();
                // Note: ordering with all:true is per-branch, not topological
                for (const branch of branches) {
                    try {
                        const commits = await git.log({
                            fs: this.fs,
                            dir: this.dir,
                            ref: branch,
                            depth: options.maxCount
                        });
                        for (const c of commits) {
                            if (!seen.has(c.oid)) {
                                seen.add(c.oid);
                                oids.push(c.oid);
                            }
                        }
                    } catch {
                        // Skip branches without commits
                    }
                }
            } else {
                const commits = await git.log({
                    fs: this.fs,
                    dir: this.dir,
                    ref,
                    depth: options?.maxCount
                });
                oids = commits.map(c => c.oid);
            }

            if (options?.reverse) {
                oids = oids.reverse();
            }

            this._logOperation('revList', { options }, { success: true, count: oids.length });
            return oids;
        } catch (error) {
            this._logOperation('revList', { options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Returns the history of all operations performed
     * @returns List of operations
     */
    getOperationsLog(): OperationLogEntry[] {
        return [...this.operations];
    }

    /**
     * Clears the operation log
     */
    clearOperationsLog(): void {
        this.operations = [];
        this._logOperation('clearOperationsLog', {}, { success: true });
    }

    /**
     * Gets operation statistics
     * @returns Statistics
     */
    getOperationsStats(): OperationStats {
        const stats: OperationStats = {
            total: this.operations.length,
            successful: this.operations.filter(op => op.success).length,
            failed: this.operations.filter(op => !op.success).length,
            byOperation: {}
        };
        
        for (const op of this.operations) {
            if (!stats.byOperation[op.operation]) {
                stats.byOperation[op.operation] = { total: 0, successful: 0, failed: 0 };
            }
            stats.byOperation[op.operation].total++;
            if (op.success) {
                stats.byOperation[op.operation].successful++;
            } else {
                stats.byOperation[op.operation].failed++;
            }
        }
        
        return stats;
    }

    /**
     * Exports the operation log in JSON format
     * @returns JSON string of operations
     */
    exportOperationsLog(): string {
        return JSON.stringify({
            name: this.name,
            exportedAt: new Date().toISOString(),
            stats: this.getOperationsStats(),
            operations: this.operations
        }, null, 2);
    }

    /**
     * Syncs all changes from memory to disk
     * @param targetPath - Destination path (optional, uses original path if not specified)
     * @param options - Flush options
     * @returns Number of files flushed
     */
    async flush(targetPath: string | null = null, options: FlushOptions = {}): Promise<number> {
        try {
            const destination = targetPath ? pathNode.resolve(targetPath) : this.realDir;
            
            if (!destination) {
                throw new Error('No destination path specified and repository was not loaded from disk');
            }
            
            // Create destination directory if it doesn't exist (async)
            const destinationExists = await this._realPathExists(destination);
            if (!destinationExists) {
                await fsRealAsync.mkdir(destination, { recursive: true });
            }
            
            // Copy recursively from memory to disk (async)
            const fileCount = await this._copyToDiskAsync(this.dir, destination);
            
            this._logOperation('flush', { targetPath: destination, options }, { 
                success: true,
                filesFlushed: fileCount
            });
            
            return fileCount;
        } catch (error) {
            this._logOperation('flush', { targetPath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Copies files from memory to disk (async)
     * @private
     */
    private async _copyToDiskAsync(memoryPath: string, realPath: string): Promise<number> {
        const entries = this.fs.readdirSync(memoryPath) as string[];
        
        // Process entries in parallel for better performance
        const promises = entries.map(async (entry) => {
            const memoryEntryPath = pathNode.posix.join(memoryPath, entry);
            const realEntryPath = pathNode.join(realPath, entry);
            
            const stat = this.fs.statSync(memoryEntryPath);
            
            if (stat.isDirectory()) {
                const dirExists = await this._realPathExists(realEntryPath);
                if (!dirExists) {
                    await fsRealAsync.mkdir(realEntryPath, { recursive: true });
                }
                return await this._copyToDiskAsync(memoryEntryPath, realEntryPath);
            } else {
                const content = this.fs.readFileSync(memoryEntryPath);
                await fsRealAsync.writeFile(realEntryPath, content);
                return 1;
            }
        });
        
        const results = await Promise.all(promises);
        return results.reduce((acc, val) => acc + val, 0);
    }

    /**
     * Lists files in the in-memory repository
     * @param dir - Relative directory (optional)
     * @param includeGit - Include .git folder in listing
     * @returns List of files
     */
    async listFiles(dir: string = '', includeGit: boolean = false): Promise<string[]> {
        try {
            const fullPath = pathNode.posix.join(this.dir, dir);
            const files = this._listFilesRecursive(fullPath, '', includeGit);
            this._logOperation('listFiles', { dir }, { success: true, files: files.length });
            return files;
        } catch (error) {
            this._logOperation('listFiles', { dir }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists files recursively
     * @private
     */
    private _listFilesRecursive(dir: string, base: string = '', includeGit: boolean = false): string[] {
        const files: string[] = [];
        const entries = this.fs.readdirSync(dir) as string[];
        
        for (const entry of entries) {
            const fullPath = pathNode.posix.join(dir, entry);
            const relativePath = base ? pathNode.posix.join(base, entry) : entry;
            const stat = this.fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                if (entry === '.git' && !includeGit) continue;
                files.push(...this._listFilesRecursive(fullPath, relativePath, includeGit));
            } else {
                files.push(relativePath);
            }
        }
        
        return files;
    }

    /**
     * Gets the diff
     * - Default: working tree vs HEAD (all unstaged + staged changes)
     * - {cached: true}: index vs HEAD (git diff --cached)
     * - {fromRef, toRef}: two-ref diff (git diff <a> <b>)
     * @param options - Diff options
     * @returns List of changed file entries
     */
    async diff(options: DiffOptions = {}): Promise<DiffEntry[]> {
        try {
            let changes: DiffEntry[];

            if (options.fromRef) {
                const toRef = options.toRef ?? 'HEAD';
                const changed = await this.getChangedFiles(options.fromRef, toRef);
                changes = changed.map(c => ({ filepath: c.filepath, status: c.status }));
            } else {
                const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
                changes = [];
                for (const [filepath, head, workdir, stage] of matrix) {
                    const h = head as number;
                    const w = workdir as number;
                    const s = stage as number;

                    if (options.cached) {
                        // Only differences between HEAD and index
                        if (h !== s) {
                            changes.push({
                                filepath: filepath as string,
                                status: this._getStatusText(h, w, s)
                            });
                        }
                    } else {
                        if (h !== w || h !== s) {
                            changes.push({
                                filepath: filepath as string,
                                status: this._getStatusText(h, w, s)
                            });
                        }
                    }
                }
            }

            if (options.paths && options.paths.length > 0) {
                const set = new Set(options.paths);
                changes = changes.filter(c => set.has(c.filepath));
            }

            this._logOperation('diff', { options }, { success: true, changes: changes.length });
            return changes;
        } catch (error) {
            this._logOperation('diff', { options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Gets file content at a specific commit
     * @param filepath - File path
     * @param ref - Reference (commit SHA, branch, tag)
     * @param options - Encoding options ('utf8' returns string, 'buffer' returns Buffer)
     * @returns File content as string (default) or Buffer
     */
    async readFileAtRef(filepath: string, ref: string = 'HEAD', options?: { encoding?: 'utf8' | 'buffer' }): Promise<string | Buffer> {
        try {
            const { blob } = await git.readBlob({
                fs: this.fs,
                dir: this.dir,
                oid: await git.resolveRef({ fs: this.fs, dir: this.dir, ref }),
                filepath
            });

            const result: string | Buffer = options?.encoding === 'buffer'
                ? Buffer.from(blob)
                : Buffer.from(blob).toString('utf8');

            this._logOperation('readFileAtRef', { filepath, ref }, { success: true });
            return result;
        } catch (error) {
            this._logOperation('readFileAtRef', { filepath, ref }, null, error as Error);
            throw error;
        }
    }

    /**
     * Resets file changes
     * @param filepath - File path
     */
    async resetFile(filepath: string): Promise<boolean> {
        try {
            await git.checkout({ 
                fs: this.fs, 
                dir: this.dir, 
                filepaths: [filepath],
                force: true
            });
            this._logOperation('resetFile', { filepath }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('resetFile', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Stashes current changes (simulates by saving in memory)
     * @returns Number of files saved to stash
     */
    async stash(): Promise<number> {
        try {
            // Walk workdir + tracked directly to avoid memfs/statusMatrix cache miss
            const workdirFiles = new Set(this._listFilesRecursive(this.dir));
            let trackedFiles: string[] = [];
            try {
                trackedFiles = await git.listFiles({ fs: this.fs, dir: this.dir, ref: 'HEAD' });
            } catch {
                // No HEAD yet
            }
            const tracked = new Set(trackedFiles);

            const stashedFiles: StashedFile[] = [];

            for (const filepath of workdirFiles) {
                const fullPath = pathNode.posix.join(this.dir, filepath);
                const content = this.fs.readFileSync(fullPath) as Buffer;
                if (!tracked.has(filepath)) {
                    stashedFiles.push({ filepath, content, wasNew: true });
                    continue;
                }
                try {
                    const headContent = await this.readFileAtRef(filepath, 'HEAD', { encoding: 'buffer' }) as Buffer;
                    if (!Buffer.from(content).equals(headContent)) {
                        stashedFiles.push({ filepath, content, wasNew: false });
                    }
                } catch {
                    stashedFiles.push({ filepath, content, wasNew: false });
                }
            }

            for (const filepath of tracked) {
                if (!workdirFiles.has(filepath)) {
                    stashedFiles.push({ filepath, deleted: true });
                }
            }

            this._stash.push(stashedFiles);
            // Workdir is being reverted to HEAD — anything dirty no longer applies
            this._dirtyFiles.clear();

            // Reset workdir to HEAD for each stashed file
            for (const file of stashedFiles) {
                const fullPath = pathNode.posix.join(this.dir, file.filepath);
                if (file.wasNew) {
                    try { this.fs.unlinkSync(fullPath); } catch { /* ignore */ }
                } else {
                    // Restore from HEAD by writing the blob content directly
                    try {
                        const headContent = await this.readFileAtRef(file.filepath, 'HEAD', { encoding: 'buffer' }) as Buffer;
                        const dirOnly = pathNode.posix.dirname(fullPath);
                        this.fs.mkdirSync(dirOnly, { recursive: true });
                        this.fs.writeFileSync(fullPath, headContent);
                    } catch {
                        // Ignore
                    }
                }
            }

            this._logOperation('stash', {}, { success: true, files: stashedFiles.length });
            return stashedFiles.length;
        } catch (error) {
            this._logOperation('stash', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Restores from stash
     * @returns Number of files restored
     */
    async stashPop(): Promise<number> {
        try {
            if (this._stash.length === 0) {
                throw new Error('No stash available');
            }
            
            const stashedFiles = this._stash.pop()!;
            
            for (const file of stashedFiles) {
                const fullPath = pathNode.posix.join(this.dir, file.filepath);
                if (file.deleted) {
                    try {
                        this.fs.unlinkSync(fullPath);
                    } catch {
                        // Ignore
                    }
                } else {
                    // Create directory if needed
                    const dir = pathNode.posix.dirname(fullPath);
                    this.fs.mkdirSync(dir, { recursive: true });
                    this.fs.writeFileSync(fullPath, file.content!);
                }
                // Restored content differs from index → user will want to re-stage
                this._dirtyFiles.add(file.filepath);
            }

            this._logOperation('stashPop', {}, { success: true, files: stashedFiles.length });
            return stashedFiles.length;
        } catch (error) {
            this._logOperation('stashPop', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists available stashes
     * @returns Number of stashes
     */
    stashList(): number {
        return this._stash.length;
    }

    /**
     * Clones a remote repository to memory
     * @param url - Repository URL
     * @param options - Clone options
     */
    async clone(url: string, options: CloneOptions = {}): Promise<boolean> {
        try {
            this.fs.mkdirSync(this.dir, { recursive: true });

            const { depth, singleBranch, branch, noCheckout, ...rest } = options;

            await git.clone({
                fs: this.fs,
                http,
                dir: this.dir,
                url,
                depth: depth || undefined,
                singleBranch: singleBranch || false,
                ref: branch,
                noCheckout: noCheckout || false,
                ...rest
            });

            this.isInitialized = true;
            // After clone, workdir and index are in sync — nothing pending
            this._dirtyFiles.clear();
            this._logOperation('clone', { url, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('clone', { url, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Fetches from a remote
     * @param remoteOrOptions - Remote name string (legacy) or FetchOptions
     */
    async fetch(remoteOrOptions: string | FetchOptions = 'origin'): Promise<boolean> {
        const options: FetchOptions =
            typeof remoteOrOptions === 'string' ? { remote: remoteOrOptions } : remoteOrOptions;
        const remote = options.remote ?? 'origin';

        try {
            await git.fetch({
                fs: this.fs,
                http,
                dir: this.dir,
                remote,
                prune: options.prune,
                tags: options.tags,
                depth: options.depth,
                singleBranch: options.singleBranch,
                ref: options.ref
            });
            this._logOperation('fetch', { remote, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('fetch', { remote, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Pulls from a remote
     * @param remoteOrOptions - Remote name string (legacy) or PullOptions
     * @param branch - Branch name (legacy positional)
     */
    async pull(
        remoteOrOptions: string | PullOptions = 'origin',
        branch: string | null = null
    ): Promise<boolean> {
        const options: PullOptions =
            typeof remoteOrOptions === 'string'
                ? { remote: remoteOrOptions, branch: branch ?? undefined }
                : remoteOrOptions;
        const remote = options.remote ?? 'origin';

        try {
            const currentBranchName = options.branch || await this.currentBranch();

            await git.pull({
                fs: this.fs,
                http,
                dir: this.dir,
                remote,
                ref: currentBranchName,
                author: this.author,
                fastForward: options.fastForward,
                fastForwardOnly: options.fastForwardOnly
            });

            this._logOperation('pull', { remote, branch: currentBranchName, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('pull', { remote, branch, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Pushes to a remote
     * @param remoteOrOptions - Remote name string (legacy) or PushOptions
     * @param ref - Ref to push (legacy positional, default: current branch)
     * @returns isomorphic-git PushResult
     */
    async push(
        remoteOrOptions: string | PushOptions = 'origin',
        ref?: string
    ): Promise<unknown> {
        const options: PushOptions =
            typeof remoteOrOptions === 'string'
                ? { remote: remoteOrOptions, ref }
                : remoteOrOptions;
        const remote = options.remote ?? 'origin';

        try {
            const result = await git.push({
                fs: this.fs,
                http,
                dir: this.dir,
                remote,
                ref: options.ref,
                remoteRef: options.remoteRef,
                force: options.force,
                delete: options.delete
            });
            this._logOperation('push', { remote, options }, { success: true });
            return result;
        } catch (error) {
            this._logOperation('push', { remote, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Clears the in-memory filesystem and reinitializes
     */
    async clear(): Promise<boolean> {
        try {
            this.vol.reset();
            this.isInitialized = false;
            this._stash = [];
            this._dirtyFiles.clear();
            this._logOperation('clear', {}, { success: true });
            return true;
        } catch (error) {
            this._logOperation('clear', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Gets repository information
     * @returns Repository information
     */
    async getRepoInfo(): Promise<RepoInfo> {
        const info: RepoInfo = {
            initialized: this.isInitialized,
            memoryDir: this.dir,
            realDir: this.realDir,
            currentBranch: null,
            branches: [],
            remotes: [],
            fileCount: 0,
            commits: 0
        };
        
        if (this.isInitialized) {
            info.currentBranch = (await this.currentBranch()) || null;
            info.branches = await this.listBranches();
            info.remotes = await this.listRemotes();
            info.fileCount = this._countFiles(this.dir);
            
            try {
                const logEntries = await git.log({ fs: this.fs, dir: this.dir });
                info.commits = logEntries.length;
            } catch {
                // Repo without commits
            }
        }
        
        return info;
    }

    /**
     * Formats status as porcelain v1 / short text (git status --porcelain or -s)
     * Each line is `XY filename` where X = staged, Y = working tree.
     */
    async statusText(options: { porcelain?: boolean; short?: boolean; branch?: boolean } = {}): Promise<string> {
        const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        const lines: string[] = [];

        if (options.branch) {
            const current = await git.currentBranch({ fs: this.fs, dir: this.dir });
            lines.push(`## ${current ?? 'HEAD (no branch)'}`);
        }

        for (const [filepath, head, workdir, stage] of matrix) {
            const h = head as number;
            const w = workdir as number;
            const s = stage as number;
            if (h === 1 && w === 1 && s === 1) continue; // unmodified

            let X = ' ';
            let Y = ' ';

            if (h === 0 && s === 0) {
                X = '?';
                Y = '?';
            } else {
                // Staged column (head vs stage)
                if (h === 0 && s !== 0) X = 'A';
                else if (h === 1 && s === 0) X = 'D';
                else if (h === 1 && s !== 1 && s !== 0) X = 'M';

                // Working tree column (stage vs workdir)
                if (s !== 0 && w === 0) Y = 'D';
                else if (s !== 0 && w !== 0 && s !== w) Y = 'M';
                else if (h === 0 && s === 0 && w === 2) Y = '?';
            }

            lines.push(`${X}${Y} ${filepath}`);
        }

        return lines.join('\n');
    }

    /**
     * Formats commit log as text (git log [--oneline])
     */
    async logText(options: LogOptions & { oneline?: boolean } = {}): Promise<string> {
        const { oneline, ...logOpts } = options;
        const commits = await this.log(logOpts);
        if (oneline) {
            return commits.map(c => `${c.sha.slice(0, 7)} ${c.message.trim().split('\n')[0]}`).join('\n');
        }
        return commits.map(c => {
            const date = new Date(c.timestamp).toString();
            return `commit ${c.sha}\nAuthor: ${c.author} <${c.email}>\nDate:   ${date}\n\n    ${c.message.trim().replace(/\n/g, '\n    ')}\n`;
        }).join('\n');
    }

    /**
     * Formats diff entries as text (--name-only / --name-status)
     */
    async diffText(options: DiffOptions & { nameOnly?: boolean; nameStatus?: boolean } = {}): Promise<string> {
        const { nameOnly, nameStatus, ...diffOpts } = options;
        const entries = await this.diff(diffOpts);
        if (nameOnly) return entries.map(e => e.filepath).join('\n');
        if (nameStatus) {
            return entries.map(e => {
                const letter = e.status.includes('deleted') ? 'D'
                    : e.status.includes('new') || e.status.includes('added') ? 'A'
                    : 'M';
                return `${letter}\t${e.filepath}`;
            }).join('\n');
        }
        // Default: file + human-readable status
        return entries.map(e => `${e.filepath}: ${e.status}`).join('\n');
    }

    /**
     * Formats branch list (git branch). Current branch is prefixed with '* '
     */
    async branchText(): Promise<string> {
        const branches = await this.listBranches();
        return branches.map(b => `${b.current ? '* ' : '  '}${b.name}`).join('\n');
    }

    /**
     * Executes a bash-like git command string against this instance.
     * Strips a leading 'git' if present. Returns formatted text output mimicking the git CLI.
     *
     * Example: await mg.exec('git commit -m "fix: bug"')
     *          await mg.exec('status --porcelain')
     *
     * Throws on unknown commands or when the underlying operation fails.
     */
    async exec(cmd: string): Promise<string> {
        const tokens = shellParse(cmd).filter((t): t is string => typeof t === 'string');
        if (tokens.length === 0) return '';
        if (tokens[0] === 'git') tokens.shift();
        if (tokens.length === 0) return '';

        const sub = tokens.shift()!;
        const args = tokens;

        switch (sub) {
            case 'init': {
                const a = mri(args, { alias: { b: 'initial-branch' }, boolean: ['bare'] });
                await this.init({
                    defaultBranch: (a['initial-branch'] as string) || undefined,
                    bare: !!a.bare
                });
                return `Initialized empty Git repository in ${this.dir}/.git/`;
            }
            case 'add': {
                const a = mri(args, { alias: { A: 'all', u: 'update' }, boolean: ['all', 'update'] });
                const paths = a._;
                if (a.all || a.update) {
                    await this.add([], { all: !!a.all, update: !!a.update });
                } else if (paths.length === 0) {
                    throw new Error("Nothing specified, nothing added.");
                } else {
                    await this.add(paths.map(String));
                }
                return '';
            }
            case 'rm':
            case 'remove': {
                const a = mri(args, { boolean: ['cached', 'r', 'f'] });
                const file = String(a._[0] ?? '');
                if (!file) throw new Error('fatal: No pathspec given');
                await this.remove(file, { cached: !!a.cached });
                return `rm '${file}'`;
            }
            case 'mv': {
                const a = mri(args, { boolean: ['f'] });
                const [from, to] = a._.map(String);
                if (!from || !to) throw new Error('fatal: bad source/destination');
                await this.rename(from, to, { force: !!a.f });
                return '';
            }
            case 'commit': {
                const a = mri(args, {
                    alias: { m: 'message', a: 'all' },
                    boolean: ['amend', 'allow-empty', 'all'],
                    string: ['message', 'author', 'date']
                });
                const message = String(a.message ?? '');
                const sha = await this.commit(message, {
                    amend: !!a.amend,
                    allowEmpty: !!a['allow-empty'],
                    all: !!a.all,
                    date: a.date ? new Date(String(a.date)) : undefined,
                    author: a.author ? this._parseAuthor(String(a.author)) : undefined
                });
                const branch = (await this.currentBranch()) ?? 'HEAD';
                return `[${branch} ${sha.slice(0, 7)}] ${message.split('\n')[0]}`;
            }
            case 'status': {
                const a = mri(args, {
                    alias: { s: 'short', b: 'branch' },
                    boolean: ['short', 'porcelain', 'branch']
                });
                if (a.short || a.porcelain) {
                    return this.statusText({ porcelain: !!a.porcelain, short: !!a.short, branch: !!a.branch });
                }
                // Human-readable
                const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
                const current = (await this.currentBranch()) ?? 'HEAD';
                const lines = [`On branch ${current}`];
                const staged: string[] = [];
                const unstaged: string[] = [];
                const untracked: string[] = [];
                for (const [fp, head, workdir, stage] of matrix) {
                    const h = head as number;
                    const w = workdir as number;
                    const s = stage as number;
                    if (h === 1 && w === 1 && s === 1) continue;
                    if (h === 0 && s === 0) untracked.push(fp as string);
                    else if (h !== s) staged.push(fp as string);
                    if (s !== 0 && s !== w) unstaged.push(fp as string);
                }
                if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
                    lines.push('nothing to commit, working tree clean');
                } else {
                    if (staged.length) lines.push('Changes to be committed:', ...staged.map(f => `\tnew/modified:   ${f}`));
                    if (unstaged.length) lines.push('Changes not staged for commit:', ...unstaged.map(f => `\tmodified:   ${f}`));
                    if (untracked.length) lines.push('Untracked files:', ...untracked.map(f => `\t${f}`));
                }
                return lines.join('\n');
            }
            case 'log': {
                const a = mri(args, {
                    alias: { n: 'max-count' },
                    boolean: ['oneline', 'all'],
                    string: ['author', 'since', 'until']
                });
                const ref = a._[0] ? String(a._[0]) : undefined;
                return this.logText({
                    depth: a['max-count'] ? Number(a['max-count']) : undefined,
                    ref,
                    author: a.author ? String(a.author) : undefined,
                    since: a.since ? new Date(String(a.since)) : undefined,
                    until: a.until ? new Date(String(a.until)) : undefined,
                    oneline: !!a.oneline
                });
            }
            case 'show': {
                const a = mri(args);
                const ref = a._[0] ? String(a._[0]) : 'HEAD';
                const r = await this.show(ref);
                const lines = [
                    `commit ${r.commit.sha}`,
                    `Author: ${r.commit.author} <${r.commit.email}>`,
                    `Date:   ${new Date(r.commit.timestamp).toString()}`,
                    '',
                    `    ${r.commit.message.trim().replace(/\n/g, '\n    ')}`,
                    '',
                    ...r.changes.map(c => `${c.status[0].toUpperCase()}\t${c.filepath}`)
                ];
                return lines.join('\n');
            }
            case 'diff': {
                const a = mri(args, {
                    boolean: ['cached', 'staged', 'name-only', 'name-status']
                });
                const refs = a._.map(String);
                return this.diffText({
                    cached: !!(a.cached || a.staged),
                    fromRef: refs[0],
                    toRef: refs[1],
                    nameOnly: !!a['name-only'],
                    nameStatus: !!a['name-status']
                });
            }
            case 'branch': {
                const a = mri(args, {
                    alias: { d: 'delete', D: 'delete-force', m: 'move' },
                    string: ['delete', 'delete-force'],
                    boolean: ['move']
                });
                if (a.move) {
                    const [oldN, newN] = a._.map(String);
                    if (!oldN || !newN) throw new Error('branch -m requires <old> <new>');
                    await this.renameBranch(oldN, newN);
                    return '';
                }
                if (a['delete-force']) {
                    await this.deleteBranch(String(a['delete-force']), { force: true });
                    return '';
                }
                if (a.delete) {
                    await this.deleteBranch(String(a.delete));
                    return '';
                }
                if (a._.length > 0) {
                    await this.createBranch(String(a._[0]));
                    return '';
                }
                return this.branchText();
            }
            case 'checkout': {
                const a = mri(args, {
                    alias: { b: 'create-branch', f: 'force' },
                    boolean: ['create-branch', 'force']
                });
                const positional = a._.map(String);
                const sep = positional.indexOf('--');
                const refs = sep >= 0 ? positional.slice(0, sep) : positional;
                const files = sep >= 0 ? positional.slice(sep + 1) : undefined;
                const ref = refs[0];
                if (!ref) throw new Error('fatal: you must specify a branch or ref');
                await this.checkout(ref, {
                    createBranch: !!a['create-branch'],
                    force: !!a.force,
                    files
                });
                return a['create-branch']
                    ? `Switched to a new branch '${ref}'`
                    : `Switched to branch '${ref}'`;
            }
            case 'merge': {
                const a = mri(args, {
                    alias: { m: 'message' },
                    boolean: ['no-ff', 'ff-only'],
                    string: ['message']
                });
                const branch = String(a._[0] ?? '');
                if (!branch) throw new Error('fatal: No branch specified');
                const result = await this.merge(branch, {
                    noFastForward: !!a['no-ff'],
                    fastForwardOnly: !!a['ff-only'],
                    message: a.message ? String(a.message) : undefined
                });
                if (result.alreadyMerged) return 'Already up to date.';
                if (result.fastForward) return `Fast-forward to ${result.oid?.slice(0, 7)}`;
                return `Merge made by recursive into ${(await this.currentBranch()) ?? 'HEAD'}`;
            }
            case 'tag': {
                const a = mri(args, {
                    alias: { a: 'annotated', d: 'delete', m: 'message', l: 'list', f: 'force' },
                    boolean: ['annotated', 'list', 'force'],
                    string: ['message', 'delete']
                });
                if (a.delete) {
                    await this.deleteTag(String(a.delete));
                    return `Deleted tag '${a.delete}'`;
                }
                if (a.list || a._.length === 0) {
                    return (await this.listTags()).join('\n');
                }
                const [name, ref] = a._.map(String);
                await this.createTag(name, {
                    ref: ref || 'HEAD',
                    annotated: !!a.annotated,
                    message: a.message ? String(a.message) : undefined,
                    force: !!a.force
                });
                return '';
            }
            case 'reset': {
                const a = mri(args, {
                    boolean: ['soft', 'mixed', 'hard']
                });
                const positional = a._.map(String);
                const sep = positional.indexOf('--');
                const refs = sep >= 0 ? positional.slice(0, sep) : positional;
                const paths = sep >= 0 ? positional.slice(sep + 1) : undefined;
                const mode: ResetMode = a.hard ? 'hard' : a.soft ? 'soft' : 'mixed';
                const ref = refs[0] ?? 'HEAD';
                await this.reset(ref, { mode, paths });
                return '';
            }
            case 'clone': {
                const a = mri(args, {
                    alias: { b: 'branch' },
                    boolean: ['single-branch', 'no-checkout'],
                    string: ['branch']
                });
                const url = String(a._[0] ?? '');
                if (!url) throw new Error('fatal: You must specify a repository to clone.');
                await this.clone(url, {
                    branch: a.branch ? String(a.branch) : undefined,
                    singleBranch: !!a['single-branch'],
                    noCheckout: !!a['no-checkout'],
                    depth: a.depth ? Number(a.depth) : undefined
                });
                return `Cloning into '${this.dir}'...`;
            }
            case 'fetch': {
                const a = mri(args, { boolean: ['prune', 'tags', 'all'] });
                const remote = a._[0] ? String(a._[0]) : 'origin';
                await this.fetch({
                    remote,
                    prune: !!a.prune,
                    tags: !!a.tags,
                    depth: a.depth ? Number(a.depth) : undefined
                });
                return '';
            }
            case 'pull': {
                const a = mri(args, { boolean: ['ff-only', 'ff'] });
                const [remote, branch] = a._.map(String);
                await this.pull({
                    remote: remote || 'origin',
                    branch: branch || undefined,
                    fastForwardOnly: !!a['ff-only']
                });
                return '';
            }
            case 'push': {
                const a = mri(args, { alias: { f: 'force' }, boolean: ['force', 'delete'] });
                const [remote, ref] = a._.map(String);
                await this.push({
                    remote: remote || 'origin',
                    ref: ref || undefined,
                    force: !!a.force,
                    delete: !!a.delete
                });
                return '';
            }
            case 'remote': {
                const action = String(args[0] ?? '');
                if (!action || action === '-v' || action === '--verbose') {
                    const r = await this.listRemotes();
                    return r.map(x => `${x.remote}\t${x.url}`).join('\n');
                }
                if (action === 'add') {
                    await this.addRemote(String(args[1] ?? ''), String(args[2] ?? ''));
                    return '';
                }
                if (action === 'remove' || action === 'rm') {
                    await this.deleteRemote(String(args[1] ?? ''));
                    return '';
                }
                throw new Error(`Unknown remote subcommand: ${action}`);
            }
            case 'config': {
                const a = mri(args);
                const [key, value] = a._.map(String);
                if (!key) throw new Error('error: key required');
                const result = await this.config(key, value || undefined);
                return result ?? '';
            }
            case 'stash': {
                const action = String(args[0] ?? 'push');
                if (action === 'push' || !args[0]) {
                    const n = await this.stash();
                    return `Saved working directory and index state (${n} files)`;
                }
                if (action === 'pop') {
                    const n = await this.stashPop();
                    return `Restored ${n} files from stash`;
                }
                if (action === 'list') {
                    const n = this.stashList();
                    return Array.from({ length: n }, (_, i) => `stash@{${i}}`).join('\n');
                }
                throw new Error(`Unknown stash action: ${action}`);
            }
            case 'rev-parse': {
                const a = mri(args, { boolean: ['short', 'abbrev-ref'] });
                const ref = String(a._[0] ?? 'HEAD');
                return this.resolveRef(ref, { short: !!a.short, abbrevRef: !!a['abbrev-ref'] });
            }
            case 'ls-files': {
                return (await this.listTrackedFiles()).join('\n');
            }
            case 'rev-list': {
                const a = mri(args, {
                    boolean: ['all', 'reverse'],
                    alias: { 'max-count': 'n' }
                });
                const ref = a._[0] ? String(a._[0]) : undefined;
                const oids = await this.revList({
                    all: !!a.all,
                    reverse: !!a.reverse,
                    maxCount: a['max-count'] ? Number(a['max-count']) : undefined,
                    ref
                });
                return oids.join('\n');
            }
            default:
                throw new Error(`memory-git: '${sub}' is not a supported command`);
        }
    }

    /**
     * Parses 'Name <email>' or 'Name' string into Author
     * @private
     */
    private _parseAuthor(s: string): Author {
        const m = s.match(/^\s*(.+?)\s*<(.+?)>\s*$/);
        if (m) return { name: m[1], email: m[2] };
        return { name: s.trim(), email: this.author.email };
    }

    /**
     * Gets estimated memory usage
     * @returns Memory usage information
     */
    getMemoryUsage(): MemoryUsage {
        const json = this.vol.toJSON();
        const totalSize = Object.values(json).reduce((acc, content) => {
            if (typeof content === 'string') {
                return acc + content.length;
            }
            return acc;
        }, 0);
        
        return {
            files: Object.keys(json).length,
            estimatedSizeBytes: totalSize,
            estimatedSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            operationsLogged: this.operations.length
        };
    }
}
