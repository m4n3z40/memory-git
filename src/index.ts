import git from 'isomorphic-git';
import type { TreeEntry } from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { createFsFromVolume, Volume } from 'memfs';
import { promises as fsRealAsync } from 'fs';
import pathNode from 'path';
import { parse as shellParse } from 'shell-quote';
import ignore from 'ignore';

import { MemoizedAsync } from './memoized-async.js';
import { InFlightAsync } from './in-flight-async.js';
import { OperationLog } from './operation-log.js';
import {
    realPathExists,
    collectGitignorePatterns,
    copyDiskToMemory,
    copyDiskToMemoryIncremental,
    copyMemoryToDisk,
    copyMemoryToDiskIncremental,
    indexDiskLazy,
    listFilesRecursive,
    type FileFingerprint,
} from './disk-sync.js';
import { LazyState, wrapLazyFs } from './lazy-fs.js';
import { wrapRecordingFs } from './recording-fs.js';
import { getCommand, type Command } from './commands/index.js';
import { primeSafeCompression } from './compression-fix.js';

// git's canonical empty-tree object id (`git hash-object -t tree /dev/null`).
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export { primeSafeCompression, shouldForcePako } from './compression-fix.js';

type MemFs = ReturnType<typeof createFsFromVolume>;

// Public types live in ./types.ts. Re-exported for backwards-compatible
// `import { ... } from 'memory-git'` usage.
import type {
    Author,
    OperationLogEntry,
    FileStatus,
    CommitInfo,
    BranchInfo,
    RemoteInfo,
    OperationStats,
    RepoInfo,
    MemoryUsage,
    LoadFromDiskOptions,
    FlushOptions,
    MemoryGitOptions,
    CloneOptions,
    InitOptions,
    AddOptions,
    CommitOptions,
    RemoveOptions,
    DeleteBranchOptions,
    CheckoutOptions,
    MergeOptions,
    CreateTagOptions,
    RenameOptions,
    FetchOptions,
    PullOptions,
    PushOptions,
    LogOptions,
    ResolveRefOptions,
    DiffOptions,
    ShowResult,
    MergeResult,
    DiffEntry,
    ResetMode,
    ResetOptions,
    TagRef,
    ListTagsOptions,
    ShowTagRefsOptions,
    TagsPointingAtOptions,
    ChangedFile,
    RevListOptions,
    ExecOptions,
    OperationListener,
    GcOptions,
    GcResult,
} from './types.js';

export type {
    Author,
    OperationLogEntry,
    FileStatus,
    CommitInfo,
    BranchInfo,
    RemoteInfo,
    OperationStats,
    RepoInfo,
    MemoryUsage,
    LoadFromDiskOptions,
    FlushOptions,
    MemoryGitOptions,
    CloneOptions,
    InitOptions,
    AddOptions,
    CommitOptions,
    RemoveOptions,
    DeleteBranchOptions,
    CheckoutOptions,
    MergeOptions,
    CreateTagOptions,
    RenameOptions,
    FetchOptions,
    PullOptions,
    PushOptions,
    LogOptions,
    ResolveRefOptions,
    DiffOptions,
    ShowResult,
    MergeResult,
    DiffEntry,
    ResetMode,
    ResetOptions,
    TagRef,
    ListTagsOptions,
    ShowTagRefsOptions,
    TagsPointingAtOptions,
    ChangedFile,
    RevListOptions,
    ExecOptions,
    OperationListener,
    GcOptions,
    GcResult,
} from './types.js';

/** Internal: shape used by the stash stack. Not part of the public surface. */
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
    
    private _log: OperationLog = new OperationLog();
    private _stash: StashedFile[][] = [];
    /**
     * Workdir paths known to have been written/deleted since the last add/sync.
     * Used as a fast-path for `add('.')` / `add({all|update})` so we don't re-hash
     * every tracked file on each call (which is the main perf cost vs git CLI).
     * Synced on: explicit add(paths), checkout, reset(hard), merge, stash, clone.
     */
    private _dirtyFiles: Set<string> = new Set();
    /**
     * Repo-relative paths mutated in memory but not yet flushed to disk —
     * working-tree writes AND internal `.git/` writes (objects, refs, index,
     * HEAD) from any mutating op. Recorded at the fs layer (see
     * recording-fs.ts), surfaced by `isDirty()`/`getDirtyPaths()`, and cleared
     * by `flush()` (for persisted paths) and `loadFromDisk()`/`clear()`. Lets
     * the consumer decide *when* to flush under the write-behind model.
     */
    private _unpersisted: Set<string> = new Set();
    /**
     * Fingerprint of every file we know to be on disk, keyed by repo-relative
     * path. Populated by `loadFromDisk` (unless `skipSnapshot:true`) and
     * updated by `flush`. Lets us skip reads/writes of files whose disk state
     * matches what we last synced. Reset on `clear()`.
     */
    private _diskSnapshot: Map<string, FileFingerprint> = new Map();
    /**
     * Resolved disk path the snapshot represents. Different from `realDir`
     * (which is the original load source) so that `flush(otherDir)` can build
     * a snapshot keyed to that destination without losing it between calls.
     */
    private _snapshotPath: string | null = null;
    /**
     * Per-instance toggle for snapshot tracking. False ⇒ `loadFromDisk` skips
     * the hash pass and `flush` always does a full rewrite silently. Set via
     * the constructor's `{tracksDiskSnapshot:false}` option.
     */
    private _tracksDiskSnapshot: boolean = true;
    /**
     * True when the last `loadFromDisk` ran with `skipSnapshot:true` and the
     * caller therefore has no baseline. Used so flush can warn the user that
     * it's silently falling back to a full rewrite instead of incremental.
     * Cleared by any load/flush/clear that does build or invalidate a snapshot.
     */
    private _snapshotSkippedAtLoad: boolean = false;

    /**
     * Read-only flag. False on regular instances; locked to `true` on the
     * sibling returned by `readOnlyView()`.
     */
    private _readOnly: boolean = false;

    /**
     * Lazy mode flag. Set via constructor `{lazy:true}`. When true,
     * `loadFromDisk` indexes paths without reading their bytes, and `this.fs`
     * is wrapped to fault them in on first access. See `lazy-fs.ts`.
     */
    private _lazy: boolean = false;
    /**
     * Lazy index. Non-empty only when `_lazy` is true and a `loadFromDisk`
     * has populated it. Updated through the wrapped `this.fs` as files
     * are read/written/deleted.
     */
    private _lazyState: LazyState = new LazyState();
    /**
     * Direct (unwrapped) memfs view used by flush walks. In non-lazy mode
     * it's the same object as `this.fs`. In lazy mode it bypasses the
     * lazy wrapper so memory→disk sync only sees files actually in memory
     * — untouched lazy files stay on disk untouched.
     */
    private _rawFs: MemFs;

    /**
     * Creates a new MemoryGit instance.
     * @param name - Unique name to identify the instance
     * @param options - Instance options (e.g. `{tracksDiskSnapshot:false}` to disable incremental sync entirely, `{lazy:true}` to defer disk reads until first access)
     */
    constructor(name: string = 'memory-git', options: MemoryGitOptions = {}) {
        this.name = name;
        this.vol = new Volume();
        const rawFs = createFsFromVolume(this.vol);
        this._rawFs = rawFs;
        if (options.tracksDiskSnapshot === false) {
            this._tracksDiskSnapshot = false;
        }
        let baseFs: MemFs;
        if (options.lazy === true) {
            this._lazy = true;
            baseFs = wrapLazyFs(rawFs, this._lazyState, (memPath, size, mtimeMs, hash) => {
                // Translate the in-memory path back to the snapshot key
                // (repo-relative). The snapshot is keyed off `this.dir`,
                // not the wrapper's view of it, so we strip the prefix.
                const rel = memPath.startsWith(this.dir + '/')
                    ? memPath.slice(this.dir.length + 1)
                    : memPath;
                this._diskSnapshot.set(rel, { size, mtimeMs, hash });
            });
        } else {
            baseFs = rawFs;
        }
        // Outermost layer: record every mutation so isDirty()/getDirtyPaths()
        // reflect *all* unpersisted state, including `.git/`-only writes from
        // commit/tag/merge. Lazy materialization writes the inner volume
        // directly, bypassing this wrapper, so faulting a file in from disk is
        // correctly not counted as a mutation.
        this.fs = wrapRecordingFs(baseFs, (memPath) => this._recordUnpersisted(memPath));
    }

    /**
     * Whether this instance is read-only. True only for instances produced
     * by `readOnlyView()`; every mutating method on such an instance
     * rejects with `EROFS`. Regular instances always return false.
     */
    get readOnly(): boolean {
        return this._readOnly;
    }

    /**
     * Returns a read-only sibling that shares this instance's Volume and
     * internal state. Writes performed on the parent (or via
     * `toJustBashFs(parent)`) are visible to the view immediately — they
     * point at the same Volume. Every mutation method on the view rejects
     * with `EROFS`, and `toJustBashFs(view)` follows that automatically.
     *
     * Use when one consumer needs a read handle and another a write handle
     * on the same in-memory repo:
     *
     *   const mg = new MemoryGit(projectId);
     *   await mg.init();
     *   const mgRead = mg.readOnlyView();
     *   new ReadStrategy(mgRead);       // toJustBashFs(mgRead) is RO
     *   new WriteStrategy(mg, queue);   // toJustBashFs(mg) is RW
     */
    readOnlyView(): MemoryGit {
        const parent = this;
        const view = Object.create(MemoryGit.prototype) as MemoryGit;

        // Field initializers don't run when we bypass the constructor with
        // Object.create. Wire every field on the view to read/write the
        // parent's slot, so the view sees parent mutations (volume, refs,
        // dirty set, log) live.
        const sharedFields = [
            'name', 'fs', 'vol', 'dir',
            'realDir', 'isInitialized', 'author',
            '_log', '_stash', '_dirtyFiles', '_unpersisted', '_diskSnapshot', '_snapshotPath',
            '_tracksDiskSnapshot', '_snapshotSkippedAtLoad',
            // Per-instance read caches: the view shares the parent's volume and
            // state, so it must share the cache instances too — otherwise a
            // parent-side write that invalidates a cache wouldn't be seen here.
            '_tagOidsCache', '_currentBranchCache', '_branchListCache',
            '_statusMatrixInFlight',
        ] as const;
        for (const key of sharedFields) {
            Object.defineProperty(view, key, {
                get: () => Reflect.get(parent, key),
                set: (v: unknown) => { Reflect.set(parent, key, v); },
                enumerable: true,
                configurable: true,
            });
        }

        // The view's only divergence from the parent: a locked `_readOnly =
        // true`. `writable: false` blocks `(view as any)._readOnly = false`
        // from silently undoing the contract.
        Object.defineProperty(view, '_readOnly', {
            value: true,
            writable: false,
            configurable: false,
        });

        return view;
    }

    /**
     * Throws an `EROFS` error if this instance is in read-only mode.
     * @private
     */
    private _assertWritable(operation: string): void {
        if (!this._readOnly) return;
        const err = new Error(
            `EROFS: read-only file system, ${operation}`,
        ) as NodeJS.ErrnoException;
        err.code = 'EROFS';
        err.errno = -30;
        err.syscall = operation;
        throw err;
    }

    /**
     * Public Node-fs-compatible interface backed by the in-memory Volume.
     * Use when integrating with libraries that need an IFs-shaped filesystem
     * (e.g. memory-git/just-bash-fs).
     */
    get volume(): MemFs {
        return this.fs;
    }

    /**
     * Subscribe to operation-log entries as they are recorded.
     * @returns Unsubscribe function.
     */
    onOperation(callback: OperationListener): () => void {
        return this._log.subscribe(callback);
    }

    /**
     * Records an operation entry. Internal — the OperationLog instance owns
     * sanitization and observer dispatch.
     * @private
     */
    private _logOperation(
        operation: string,
        params: Record<string, unknown>,
        result: unknown = null,
        error: Error | null = null,
    ): OperationLogEntry {
        return this._log.record(operation, params, result, error);
    }

    /**
     * Throws an AbortError if the given signal is aborted. Web-standard shape.
     * @private
     */
    private _checkSignal(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
    }

    /**
     * Races a promise against an AbortSignal. If the signal aborts before the
     * promise settles, throws AbortError. The underlying operation continues
     * running internally — callers are responsible for any rollback.
     * @private
     */
    private _withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return promise;
        if (signal.aborted) {
            return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
        }
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                v => { signal.removeEventListener('abort', onAbort); resolve(v); },
                e => { signal.removeEventListener('abort', onAbort); reject(e); },
            );
        });
    }

    /**
     * Resolves a ref or short OID to a full OID. Accepts symbolic refs
     * (HEAD, branch, tag), hex hashes, and the git revision-suffix syntax
     * (`~`, `~N`, `^`, `^N`, chained — e.g. `HEAD~2`, `main^`, `HEAD~2^3`).
     * isomorphic-git's `resolveRef` doesn't understand the suffixes, so we
     * strip them, resolve the base, then walk parents via `readCommit`.
     * @private
     */
    private async _resolveAny(ref: string): Promise<string> {
        const { base, ops } = this._parseRevSuffix(ref);
        if (!base) throw new Error(`fatal: bad revision '${ref}'`);
        let oid: string;
        // `.git/FETCH_HEAD` uses git's multi-line `<oid>\t[not-for-merge]\t<desc>`
        // format, which isomorphic-git's resolveRef doesn't parse (it trims and
        // recurses). Read it directly when asked.
        if (base === 'FETCH_HEAD') {
            const fromFile = this._readFetchHeadOid();
            if (!fromFile) throw new Error(`Could not find ${ref}.`);
            oid = fromFile;
        } else {
            try {
                oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: base });
            } catch (e) {
                if (/^[0-9a-f]{4,40}$/i.test(base)) {
                    oid = await git.expandOid({ fs: this.fs, dir: this.dir, oid: base });
                } else {
                    // Preserve the original git CLI error shape — callers (and tests)
                    // grep for "Could not find <ref>" / "bad revision <ref>".
                    throw e;
                }
            }
        }
        return ops.length > 0 ? this._walkRevSuffix(oid, ops, ref) : oid;
    }

    /**
     * Reads `.git/FETCH_HEAD` and returns the oid of the merge candidate
     * (the first line whose middle column is NOT "not-for-merge", falling
     * back to the first line). Returns `null` if the file is missing.
     * @private
     */
    private _readFetchHeadOid(): string | null {
        const path = pathNode.posix.join(this.dir, '.git', 'FETCH_HEAD');
        if (!this.fs.existsSync(path)) return null;
        const content = (this.fs.readFileSync(path, 'utf8') as string).trim();
        if (!content) return null;
        const lines = content.split('\n');
        // Format per `git help fetch`: `<oid>\t[not-for-merge]\t<desc>`
        // Prefer the merge candidate (empty 2nd field); fall back to first line.
        const merge = lines.find(l => {
            const parts = l.split('\t');
            return parts.length >= 2 && parts[1].trim() === '';
        });
        const chosen = merge ?? lines[0];
        const oid = chosen.split('\t')[0].trim();
        return /^[0-9a-f]{40}$/i.test(oid) ? oid : null;
    }

    /**
     * Splits a ref like `HEAD~2^3` into `{ base: 'HEAD', ops: [~2, ^3] }`.
     * Trailing `~` / `^` without a number is treated as `~1` / `^1`, matching
     * git CLI. Refs without a suffix come back as `{ base: ref, ops: [] }`.
     * @private
     */
    private _parseRevSuffix(ref: string): { base: string; ops: Array<{ type: '~' | '^'; n: number }> } {
        const ops: Array<{ type: '~' | '^'; n: number }> = [];
        let i = ref.length;
        while (i > 0) {
            let j = i - 1;
            while (j >= 0 && ref[j] >= '0' && ref[j] <= '9') j--;
            if (j < 0 || (ref[j] !== '~' && ref[j] !== '^')) break;
            const numStr = ref.slice(j + 1, i);
            const type = ref[j] as '~' | '^';
            const n = numStr === '' ? 1 : Number(numStr);
            ops.unshift({ type, n });
            i = j;
        }
        return { base: ref.slice(0, i), ops };
    }

    /**
     * Walks revision-suffix operations from a starting OID.
     * `~N` follows the first-parent chain N hops; `^N` picks the Nth parent
     * of the current commit (with `^0` meaning the commit itself).
     * @private
     */
    private async _walkRevSuffix(
        oid: string,
        ops: Array<{ type: '~' | '^'; n: number }>,
        originalRef: string,
    ): Promise<string> {
        let cur = oid;
        for (const op of ops) {
            if (op.type === '~') {
                for (let k = 0; k < op.n; k++) {
                    const { commit } = await git.readCommit({ fs: this.fs, dir: this.dir, oid: cur });
                    if (!commit.parent || commit.parent.length === 0) {
                        throw new Error(`fatal: ambiguous argument '${originalRef}': unknown revision (walked past root)`);
                    }
                    cur = commit.parent[0];
                }
            } else {
                if (op.n === 0) continue;
                const { commit } = await git.readCommit({ fs: this.fs, dir: this.dir, oid: cur });
                if (!commit.parent || op.n > commit.parent.length) {
                    throw new Error(`fatal: ambiguous argument '${originalRef}': commit has no parent ${op.n}`);
                }
                cur = commit.parent[op.n - 1];
            }
        }
        return cur;
    }

    /**
     * Sets the author for commits
     * @param name - Author name
     * @param email - Author email
     */
    setAuthor(name: string, email: string): void {
        this._assertWritable('setAuthor');
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
            this._assertWritable('config');
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
        this._assertWritable('init');
        await primeSafeCompression();
        const defaultBranch = options.defaultBranch ?? 'main';
        const bare = options.bare ?? false;
        try {
            this.fs.mkdirSync(this.dir, { recursive: true });
            await git.init({ fs: this.fs, dir: this.dir, defaultBranch, bare });
            this.isInitialized = true;
            this._invalidateBranchCaches();
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
        this._assertWritable('loadFromDisk');
        await primeSafeCompression();
        try {
            const resolvedSource = pathNode.resolve(sourcePath);
            const respectGitignore = options.respectGitignore !== false;
            const nestedGitignore = options.nestedGitignore !== false;
            const explicitIgnore = options.ignore ?? [];
            // Snapshot is opt-out as of 3.4. Honour the instance-wide toggle
            // first; otherwise `{skipSnapshot:true}` skips for this call. The
            // legacy `{incremental:true}` is accepted as a no-op alias of the
            // new default and never forces snapshot back on.
            const buildSnapshot =
                this._tracksDiskSnapshot && options.skipSnapshot !== true;

            // Build the matcher. .gitignore semantics: globs, negation, anchored paths.
            const matcher = ignore();
            matcher.add(explicitIgnore);

            if (respectGitignore) {
                const patterns = await collectGitignorePatterns(resolvedSource, nestedGitignore);
                if (patterns.length > 0) matcher.add(patterns);
            }

            this.fs.mkdirSync(this.dir, { recursive: true });

            // Snapshot is path-scoped: switching source path invalidates it.
            if (this._snapshotPath !== resolvedSource) {
                this._diskSnapshot.clear();
                this._snapshotPath = null;
            }
            // Likewise the lazy index — paths in it point at the old source.
            if (this._lazy) this._lazyState.reset();
            // And the tag + branch caches — refs from the prior source are stale now.
            this._invalidateTagCache();
            this._invalidateBranchCaches();
            this.realDir = resolvedSource;

            let fileCount: number;
            if (this._lazy) {
                // Lazy load: walk the tree, index file paths + sizes + mtimes
                // into the lazy state, but read no bytes. Materialization
                // happens through the wrapped fs the first time anything
                // touches a path; the wrapper's onMaterialize callback
                // populates _diskSnapshot. Setting _snapshotPath here lets
                // those incremental snapshot updates land in the right
                // baseline so a subsequent flush is incremental.
                this._snapshotPath = resolvedSource;
                this._snapshotSkippedAtLoad = false;
                let indexed = 0;
                indexed = await indexDiskLazy(
                    this.fs, this.realDir, this.dir, matcher, '',
                    (memPath, realFilePath, size, mtimeMs) => {
                        this._lazyState.addFile(memPath, { realPath: realFilePath, size, mtimeMs });
                    },
                );
                fileCount = indexed;
                this._logOperation('loadFromDisk', {
                    sourcePath: this.realDir,
                    respectGitignore,
                    nestedGitignore,
                    explicitIgnore,
                    lazy: true,
                }, { success: true, filesLoaded: fileCount, indexed, lazy: true });
            } else if (buildSnapshot) {
                this._snapshotPath = resolvedSource;
                this._snapshotSkippedAtLoad = false;
                const seen = new Set<string>();
                const { read, skipped } = await copyDiskToMemoryIncremental(
                    this.fs, this.realDir, this.dir, matcher, '', this._diskSnapshot, seen,
                );
                // Files known last time but no longer on disk → remove from memfs + snapshot.
                let removed = 0;
                for (const path of [...this._diskSnapshot.keys()]) {
                    if (seen.has(path)) continue;
                    this._diskSnapshot.delete(path);
                    const fullPath = pathNode.posix.join(this.dir, path);
                    try {
                        this.fs.unlinkSync(fullPath);
                        removed += 1;
                    } catch {
                        // Already gone or never written; ignore.
                    }
                }
                fileCount = read + skipped;
                this._logOperation('loadFromDisk', {
                    sourcePath: this.realDir,
                    respectGitignore,
                    nestedGitignore,
                    explicitIgnore,
                }, { success: true, filesLoaded: fileCount, read, skipped, removed });
            } else {
                fileCount = await copyDiskToMemory(this.fs, this.realDir, this.dir, matcher, '');
                // Caller opted out of the snapshot — invalidate any prior one
                // and remember the opt-out so the next flush can warn instead
                // of silently doing a full rewrite.
                this._diskSnapshot.clear();
                this._snapshotPath = null;
                this._snapshotSkippedAtLoad = this._tracksDiskSnapshot;
                this._logOperation('loadFromDisk', {
                    sourcePath: this.realDir,
                    respectGitignore,
                    nestedGitignore,
                    explicitIgnore,
                    skipSnapshot: true,
                }, { success: true, filesLoaded: fileCount });
            }

            // After load, every working-tree file is unsynced with the (likely empty) index.
            // Seed the dirty set so `add('.')` can pick them all up without rescanning.
            for (const f of listFilesRecursive(this.fs, this.dir)) {
                this._dirtyFiles.add(f);
            }

            // Just hydrated from disk: memory mirrors disk, nothing is pending.
            // (Eager copy writes through this.fs, which would otherwise look
            // dirty.) Lazy materialization bypasses the recorder, so this is a
            // belt-and-suspenders clear for the eager path.
            this._unpersisted.clear();
            this.isInitialized = true;
            return fileCount;
        } catch (error) {
            this._logOperation('loadFromDisk', { sourcePath }, null, error as Error);
            throw error;
        }
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
        this._assertWritable('writeFile');
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
     * @param options - Encoding. Default utf-8 returns string; `{ encoding: null }` returns Buffer
     * @returns File content as string (default) or Buffer for binary reads
     */
    async readFile(filepath: string): Promise<string>;
    async readFile(filepath: string, options: { encoding: 'utf-8' | 'utf8' }): Promise<string>;
    async readFile(filepath: string, options: { encoding: null } | null): Promise<Buffer>;
    async readFile(
        filepath: string,
        options?: { encoding: 'utf-8' | 'utf8' | null } | null,
    ): Promise<string | Buffer> {
        try {
            const fullPath = pathNode.posix.join(this.dir, filepath);
            const encoding = options === null ? null : options?.encoding;
            const wantsBuffer = encoding === null;
            if (wantsBuffer) {
                const buf = this.fs.readFileSync(fullPath) as Buffer;
                this._logOperation('readFile', { filepath }, { success: true, size: buf.length });
                return buf;
            }
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
        this._assertWritable('deleteFile');
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
        this._assertWritable('add');
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
        this._assertWritable('remove');
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
        this._assertWritable('commit');
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
                    const matrix = await this._statusMatrix();
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
            const statusMatrix = await this._statusMatrix();

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
     * For every path that was touched via memory-git's API (writeFile,
     * deleteFile, …) since the last commit/merge, compute the authoritative
     * workdir status code (0 absent, 1 matches HEAD, 2 differs) by hashing
     * the actual bytes. Returns an override map keyed by filepath.
     *
     * Bypasses isomorphic-git's stat-cache shortcut, which can report
     * "unmodified" for same-size edits performed within the same
     * filesystem-mtime second (common in fast in-memory flows).
     */
    private async _verifyDirtyWorkdir(): Promise<Map<string, number>> {
        const overrides = new Map<string, number>();
        if (this._dirtyFiles.size === 0) return overrides;
        let headOid: string | null = null;
        try {
            headOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: 'HEAD' });
        } catch {
            return overrides; // pre-first-commit repo: nothing to compare against
        }
        for (const fp of this._dirtyFiles) {
            const fullPath = pathNode.posix.join(this.dir, fp);
            const exists = this.fs.existsSync(fullPath);
            if (!exists) {
                overrides.set(fp, 0);
                continue;
            }
            try {
                const bytes = this.fs.readFileSync(fullPath) as Buffer;
                const { oid: workdirSha } = await git.hashBlob({ object: bytes });
                const headBlob = await git.readBlob({
                    fs: this.fs, dir: this.dir, oid: headOid, filepath: fp,
                }).catch(() => null);
                overrides.set(fp, headBlob && workdirSha === headBlob.oid ? 1 : 2);
            } catch {
                // Couldn't hash — leave statusMatrix's verdict alone.
            }
        }
        return overrides;
    }

    /**
     * Maps the verbose status strings produced by diff() to git's single-letter
     * --diff-filter codes (A/D/M/R/...). Returns 'X' for anything unrecognized.
     */
    private _statusToFilterCode(status: string): string {
        if (status.startsWith('added') || status.startsWith('new')) return 'A';
        if (status.startsWith('deleted')) return 'D';
        if (status.startsWith('modified')) return 'M';
        if (status === 'renamed' || status.startsWith('renamed')) return 'R';
        return 'X';
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
            const resolvedRef = await this._resolveAny(ref);
            const commits = await git.log({ fs: this.fs, dir: this.dir, depth, ref: resolvedRef });

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
        this._assertWritable('createBranch');
        try {
            await git.branch({ fs: this.fs, dir: this.dir, ref: branchName });
            this._invalidateBranchCaches();
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
        this._assertWritable('deleteBranch');
        try {
            if (!options.force) {
                const current = await this._getCurrentBranch();
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
            this._invalidateBranchCaches();
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
        this._assertWritable('renameBranch');
        try {
            await git.renameBranch({ fs: this.fs, dir: this.dir, ref: newName, oldref: oldName });
            this._invalidateBranchCaches();
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
        this._assertWritable('checkout');
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
            // HEAD moved (and -b may have added a branch) — drop the branch caches.
            this._invalidateBranchCaches();
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
            const [branches, current] = await Promise.all([
                this._getBranchNames(),
                this._getCurrentBranch(),
            ]);

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
            const branch = await this._getCurrentBranch();
            this._logOperation('currentBranch', {}, { success: true, branch });
            return branch;
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
        this._assertWritable('merge');
        let oursOid: string | undefined;
        let theirsOid: string | undefined;
        try {
            oursOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: 'HEAD' });
            theirsOid = await this._resolveAny(theirBranch);
            // Record pre-merge HEAD so abortMerge() / `reset --merge` can recover.
            // git CLI writes ORIG_HEAD unconditionally before the merge starts.
            this._writeGitStateFile('ORIG_HEAD', `${oursOid}\n`);

            // A merge strategy (ours/theirs) asks for deterministic, marker-free
            // conflict resolution. isomorphic-git's git.merge only applies the
            // strategy to blob-content conflicts; it throws on tree-level
            // conflicts (modify/delete, file<->dir type changes) and on some
            // divergent tree shapes (raw `undefined.length` TypeErrors), which
            // aborts the caller's sync. Resolve the whole merge ourselves so
            // `-X ours`/`-X theirs` can never abort — see _mergeWithStrategy.
            if (options.strategy) {
                const strategyResult = await this._mergeWithStrategy(
                    oursOid,
                    theirsOid,
                    options.strategy,
                    options,
                );
                this._logOperation('merge', { theirBranch, options }, { success: true, ...strategyResult });
                return strategyResult;
            }

            const result = await git.merge({
                fs: this.fs,
                dir: this.dir,
                // Pass the resolved oid (not the original ref string) so
                // isomorphic-git's internal resolveRef doesn't choke on refs
                // it can't parse — most notably FETCH_HEAD's multi-line shape.
                theirs: theirsOid,
                author: this.author,
                fastForward: options.noFastForward ? false : undefined,
                fastForwardOnly: options.fastForwardOnly,
                message: options.message,
                allowUnrelatedHistories: options.allowUnrelatedHistories,
            });
            // isomorphic-git's merge moves HEAD but does not refresh the
            // working tree (see its docs at merge.md). Force a checkout so
            // workdir + index match the new commit, matching git CLI.
            if (!result.alreadyMerged) {
                await git.checkout({ fs: this.fs, dir: this.dir, ref: 'HEAD', force: true });
            }
            this._dirtyFiles.clear();
            this._clearMergeStateFiles();

            this._logOperation('merge', { theirBranch, options }, { success: true, ...result });
            return result;
        } catch (error) {
            // Merge could not complete — leave MERGE_HEAD/MSG/MODE so the
            // caller can `abortMerge()` (or inspect via `mg.exec("status")`).
            if (oursOid && theirsOid) {
                this._writeGitStateFile('MERGE_HEAD', `${theirsOid}\n`);
                this._writeGitStateFile('MERGE_MSG', options.message ?? `Merge branch '${theirBranch}'\n`);
                this._writeGitStateFile('MERGE_MODE', options.noFastForward ? 'no-ff\n' : '');
            }
            this._logOperation('merge', { theirBranch, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Abort an in-progress merge, restoring the working tree to its pre-merge
     * state (mirrors `git merge --abort`).
     *
     * Requires that `merge()` previously failed and left MERGE_HEAD behind.
     * Throws if no merge is in progress.
     */
    async abortMerge(): Promise<void> {
        this._assertWritable('abortMerge');
        const mergeHeadPath = pathNode.posix.join(this.dir, '.git', 'MERGE_HEAD');
        if (!this.fs.existsSync(mergeHeadPath)) {
            throw new Error('fatal: There is no merge to abort (MERGE_HEAD missing).');
        }
        try {
            // HEAD did not move on conflict, so a forced checkout to HEAD
            // restores workdir+index from the pre-merge snapshot.
            await git.checkout({ fs: this.fs, dir: this.dir, ref: 'HEAD', force: true });
            this._clearMergeStateFiles();
            this._dirtyFiles.clear();
            this._logOperation('abortMerge', {}, { success: true });
        } catch (error) {
            this._logOperation('abortMerge', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Deterministically merges `theirsOid` into `oursOid`, resolving every
     * conflict to `strategy`'s side, then commits + checks out the result.
     * Unlike isomorphic-git's `git.merge`, this never throws on modify/delete,
     * file<->directory type changes, or unrelated-history shapes — such
     * conflicts resolve wholesale to the chosen side. Backs `git merge
     * -X ours|theirs` (e.g. the pods-manager GitHub sync).
     */
    private async _mergeWithStrategy(
        oursOid: string,
        theirsOid: string,
        strategy: 'ours' | 'theirs',
        options: MergeOptions,
    ): Promise<MergeResult> {
        const fs = this.fs;
        const dir = this.dir;

        // Up to date: theirs is already reachable from ours.
        if (
            theirsOid === oursOid ||
            (await git.isDescendent({ fs, dir, oid: oursOid, ancestor: theirsOid, depth: -1 }))
        ) {
            this._dirtyFiles.clear();
            this._clearMergeStateFiles();
            return { oid: oursOid, alreadyMerged: true };
        }

        // Fast-forward: ours is fully contained in theirs, so ours carries no
        // independent change for the strategy to prefer — advance to theirs.
        if (!options.noFastForward) {
            const canFastForward = await git.isDescendent({
                fs,
                dir,
                oid: theirsOid,
                ancestor: oursOid,
                depth: -1,
            });
            if (canFastForward) {
                await this._updateHeadTo(theirsOid);
                await git.checkout({ fs, dir, ref: 'HEAD', force: true });
                this._dirtyFiles.clear();
                this._clearMergeStateFiles();
                return { oid: theirsOid, fastForward: true };
            }
        }
        if (options.fastForwardOnly) {
            throw new Error('fatal: Not possible to fast-forward, aborting.');
        }

        // Diverged (shared ancestor) or unrelated: build the merged tree via a
        // 3-way walk, resolving every conflict to the chosen side, then commit.
        const mergeBases = await git.findMergeBase({ fs, dir, oids: [oursOid, theirsOid] });
        const baseTree =
            mergeBases.length === 1
                ? (await git.readCommit({ fs, dir, oid: mergeBases[0] })).commit.tree
                : EMPTY_TREE_OID; // 0 = unrelated, >1 = criss-cross: empty base, strategy decides
        const ourTree = (await git.readCommit({ fs, dir, oid: oursOid })).commit.tree;
        const theirTree = (await git.readCommit({ fs, dir, oid: theirsOid })).commit.tree;
        const mergedTree = await this._mergeTreesWithStrategy(baseTree, ourTree, theirTree, strategy);

        const branchName = (await this.currentBranch()) ?? 'HEAD';
        const author = {
            ...this.author,
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: new Date().getTimezoneOffset(),
        };
        const commitOid = await git.writeCommit({
            fs,
            dir,
            commit: {
                tree: mergedTree,
                parent: [oursOid, theirsOid],
                author,
                committer: author,
                message: options.message ?? `Merge commit '${theirsOid}' into ${branchName}\n`,
            },
        });
        await this._updateHeadTo(commitOid);
        await git.checkout({ fs, dir, ref: 'HEAD', force: true });
        this._dirtyFiles.clear();
        this._clearMergeStateFiles();
        return { oid: commitOid };
    }

    /**
     * Recursively builds a merged tree from a 3-way (base/ours/theirs) walk.
     * Non-conflicting changes from either side are kept as-is; any path both
     * sides changed (content, deletion, or blob<->tree type change) resolves
     * wholesale to `strategy`'s side. Returns the merged tree OID.
     */
    private async _mergeTreesWithStrategy(
        baseTreeOid: string,
        ourTreeOid: string,
        theirTreeOid: string,
        strategy: 'ours' | 'theirs',
    ): Promise<string> {
        if (ourTreeOid === theirTreeOid) return ourTreeOid;

        const [base, ours, theirs] = await Promise.all([
            this._readTreeEntries(baseTreeOid),
            this._readTreeEntries(ourTreeOid),
            this._readTreeEntries(theirTreeOid),
        ]);
        const baseByPath = new Map(base.map(e => [e.path, e]));
        const ourByPath = new Map(ours.map(e => [e.path, e]));
        const theirByPath = new Map(theirs.map(e => [e.path, e]));

        // Paths present only in base were deleted on both sides — drop them.
        const paths = new Set([...ourByPath.keys(), ...theirByPath.keys()]);
        const merged: TreeEntry[] = [];

        for (const path of paths) {
            const b = baseByPath.get(path);
            const o = ourByPath.get(path);
            const t = theirByPath.get(path);

            // Both sides keep a directory here: recurse so new files from either
            // side survive (a whole-side pick would drop the other's additions).
            if (o?.type === 'tree' && t?.type === 'tree') {
                const sub = await this._mergeTreesWithStrategy(
                    b?.type === 'tree' ? b.oid : EMPTY_TREE_OID,
                    o.oid,
                    t.oid,
                    strategy,
                );
                merged.push({ mode: '040000', path, oid: sub, type: 'tree' });
                continue;
            }

            const ourChanged = !this._sameTreeEntry(o, b);
            const theirChanged = !this._sameTreeEntry(t, b);

            let chosen: TreeEntry | undefined;
            if (!ourChanged) chosen = t; // only theirs changed (or neither)
            else if (!theirChanged) chosen = o; // only ours changed
            else chosen = strategy === 'ours' ? o : t; // both changed → strategy wins

            // `undefined` means the chosen side deleted the path → omit it.
            if (chosen) merged.push(chosen);
        }

        return git.writeTree({ fs: this.fs, dir: this.dir, tree: merged });
    }

    /** Tree entries are equal when both are absent, or share OID + mode. */
    private _sameTreeEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
        if (!a && !b) return true;
        if (!a || !b) return false;
        return a.oid === b.oid && a.mode === b.mode;
    }

    /** Reads a tree's entries, treating the empty-tree / missing OID as empty. */
    private async _readTreeEntries(treeOid: string | undefined): Promise<TreeEntry[]> {
        if (!treeOid || treeOid === EMPTY_TREE_OID) return [];
        const { tree } = await git.readTree({ fs: this.fs, dir: this.dir, oid: treeOid });
        return tree;
    }

    /** Points the current branch (or detached HEAD) at `oid`. */
    private async _updateHeadTo(oid: string): Promise<void> {
        const branch = await this._getCurrentBranch();
        if (branch) {
            await git.writeRef({ fs: this.fs, dir: this.dir, ref: `refs/heads/${branch}`, value: oid, force: true });
        } else {
            this._writeGitStateFile('HEAD', `${oid}\n`); // detached HEAD
        }
    }

    private _writeGitStateFile(name: string, content: string): void {
        const fullPath = pathNode.posix.join(this.dir, '.git', name);
        this.fs.writeFileSync(fullPath, content);
    }

    /**
     * Writes `.git/FETCH_HEAD` in real-git's format so the fetched ref is
     * immediately reachable as `FETCH_HEAD` (for `merge FETCH_HEAD`,
     * `diff HEAD FETCH_HEAD`, etc.). Line shape:
     *   <oid>\t\t<description>\n
     * (a tab after the oid marks "not-for-merge" or empty for the merged
     * branch; we leave it empty to match `git fetch <url> <ref>`.)
     * @private
     */
    private _writeFetchHead(oid: string | null | undefined, description: string | null | undefined): void {
        if (!oid) return;
        const desc = description ?? '';
        this._writeGitStateFile('FETCH_HEAD', `${oid}\t\t${desc}\n`);
    }

    private _clearMergeStateFiles(): void {
        for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) {
            const p = pathNode.posix.join(this.dir, '.git', name);
            if (this.fs.existsSync(p)) this.fs.unlinkSync(p);
        }
    }

    /**
     * Adds a remote
     * @param remoteName - Remote name
     * @param url - Remote URL
     */
    async addRemote(remoteName: string, url: string): Promise<boolean> {
        this._assertWritable('addRemote');
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
        this._assertWritable('deleteRemote');
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
        this._assertWritable('createTag');
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

            this._invalidateTagCache();
            this._logOperation('createTag', { tagName, ref, options: opts }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('createTag', { tagName, ref, options: opts }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists tags, with optional pagination and ordering.
     *
     * Default (no opts) preserves the original behavior: returns all tag
     * names in the order isomorphic-git emits them (lexicographic ascending
     * over `refs/tags/`).
     *
     * @param opts.limit - Maximum tags to return. Default: all.
     * @param opts.offset - Tags to skip from the start before applying limit.
     *   Combined with `reverse`, lets callers paginate from either end without
     *   loading the full list into the caller.
     * @param opts.reverse - When true, the result is the trailing slice
     *   (lexicographically newest names first). Useful for "give me the last
     *   N tags" without paying for the full sort upstream.
     * @returns Tag names, optionally sliced.
     */
    async listTags(opts: ListTagsOptions = {}): Promise<string[]> {
        try {
            const all = await git.listTags({ fs: this.fs, dir: this.dir });
            const ordered = opts.reverse ? [...all].reverse() : all;
            const offset = Math.max(0, opts.offset ?? 0);
            const limit = opts.limit != null ? Math.max(0, opts.limit) : undefined;
            const sliced = limit != null ? ordered.slice(offset, offset + limit) : ordered.slice(offset);
            this._logOperation('listTags', { ...opts }, { success: true, count: sliced.length, total: all.length });
            return sliced;
        } catch (error) {
            this._logOperation('listTags', { ...opts }, null, error as Error);
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
                    const branch = await this._getCurrentBranch();
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
            const oid = await this._resolveAny(ref);
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
        this._assertWritable('deleteTag');
        try {
            const tags = await git.listTags({ fs: this.fs, dir: this.dir });
            if (!tags.includes(tagName)) {
                throw new Error(`Tag not found: ${tagName}`);
            }
            await git.deleteRef({ fs: this.fs, dir: this.dir, ref: `refs/tags/${tagName}` });
            this._invalidateTagCache();
            this._logOperation('deleteTag', { tagName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteTag', { tagName }, null, error as Error);
            throw error;
        }
    }

    /**
     * Coalesce every loose ref under `.git/refs/` into a single
     * `.git/packed-refs` file, then delete the loose files. Equivalent to
     * `git pack-refs --all`.
     *
     * Why: every `loadFromDisk + describeExact` (or any tag-iterating op)
     * on a repo with thousands of loose refs costs O(N) file reads in
     * lazy mode. After `packRefs`, the same scan is a single ~80 KB read
     * for 2700 tags — observed 10× speedup on cold path. Each annotated
     * tag emits an extra `^<commitOid>` peeled line so the consumer
     * doesn't have to `readTag` to find the commit.
     *
     * Trade-off: `pack-refs` is normally run periodically (after the loose
     * count crosses a threshold) rather than on every write — packing
     * after each `tag` rebuilds the whole file. Call this from `flush`
     * or a periodic maintenance job, not from the inner write loop.
     */
    async packRefs(): Promise<{ packed: number, removed: number }> {
        this._assertWritable('packRefs');
        try {
            const gitDir = `${this.dir}/.git`;
            const refRoots = ['refs/heads', 'refs/tags', 'refs/remotes'] as const;

            // Read existing packed-refs to preserve refs already packed
            // (loose ones override them on conflict, matching git's rules).
            const existingLines: string[] = [];
            try {
                const text = await this.fs.promises.readFile(`${gitDir}/packed-refs`, 'utf8') as string;
                for (const rawLine of text.split('\n')) {
                    const line = rawLine.trim();
                    if (!line || line.startsWith('#')) continue;
                    existingLines.push(line);
                }
            } catch {
                // No prior packed-refs.
            }
            // Index existing packed refs by name so loose can shadow them.
            const packedByName = new Map<string, { oid: string; peeled?: string }>();
            for (let i = 0; i < existingLines.length; i++) {
                const line = existingLines[i];
                if (line.startsWith('^')) continue; // handled below
                const sp = line.indexOf(' ');
                if (sp === -1) continue;
                const oid = line.slice(0, sp);
                const name = line.slice(sp + 1);
                const entry: { oid: string; peeled?: string } = { oid };
                if (i + 1 < existingLines.length && existingLines[i + 1].startsWith('^')) {
                    entry.peeled = existingLines[i + 1].slice(1);
                }
                packedByName.set(name, entry);
            }

            // Collect loose refs from disk + peel annotated tags so the
            // resulting packed-refs is correct without readers needing a
            // second readTag pass.
            const looseRefs: { name: string; oid: string; peeled?: string }[] = [];
            const CONCURRENCY = 64;

            for (const root of refRoots) {
                let names: string[] = [];
                try {
                    names = await this._walkRefsTags(`${gitDir}/${root}`, '');
                } catch {
                    continue;
                }
                if (names.length === 0) continue;
                for (let i = 0; i < names.length; i += CONCURRENCY) {
                    const chunk = names.slice(i, i + CONCURRENCY);
                    const resolved = await Promise.all(chunk.map(async (relName) => {
                        const refPath = `${gitDir}/${root}/${relName}`;
                        try {
                            const raw = await this.fs.promises.readFile(refPath, 'utf8') as string;
                            const oid = raw.trim();
                            let peeled: string | undefined;
                            if (root === 'refs/tags') {
                                try {
                                    const obj = await git.readTag({ fs: this.fs, dir: this.dir, oid });
                                    peeled = obj.tag.object;
                                } catch {
                                    // Lightweight — no peel line.
                                }
                            }
                            return { name: `${root}/${relName}`, oid, peeled };
                        } catch {
                            return null;
                        }
                    }));
                    for (const r of resolved) if (r) looseRefs.push(r);
                }
            }

            // Merge: loose overrides packed.
            for (const r of looseRefs) {
                packedByName.set(r.name, { oid: r.oid, peeled: r.peeled });
            }

            // Serialize in sorted order (matches git pack-refs output).
            const names = Array.from(packedByName.keys()).sort();
            const out: string[] = ['# pack-refs with: peeled fully-peeled sorted'];
            for (const name of names) {
                const e = packedByName.get(name)!;
                out.push(`${e.oid} ${name}`);
                if (e.peeled) out.push(`^${e.peeled}`);
            }
            out.push('');

            this.fs.mkdirSync(gitDir, { recursive: true });
            await this.fs.promises.writeFile(`${gitDir}/packed-refs`, out.join('\n'));

            // Delete loose ref files now that they're in packed-refs.
            let removed = 0;
            for (const r of looseRefs) {
                try {
                    this.fs.unlinkSync(`${gitDir}/${r.name}`);
                    removed++;
                } catch {
                    // Best-effort: a stale entry not on disk is fine.
                }
            }

            this._invalidateTagCache();
            this._logOperation('packRefs', {}, { success: true, packed: names.length, removed });
            return { packed: names.length, removed };
        } catch (error) {
            this._logOperation('packRefs', {}, null, error as Error);
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
        this._assertWritable('reset');
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

            const branch = await this._getCurrentBranch();

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
                const statusMatrix = await this._statusMatrix();
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
        this._assertWritable('rename');
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
     * Resolve one tag name to its commit OID by walking refs through
     * resolveRef + readTag. Used only as a fallback for loose annotated
     * tags whose peeled OID isn't available via the packed-refs fast
     * path. Avoid calling this in a hot loop — see `_loadAllTagOids`.
     */
    private async _resolveTagToCommit(tagName: string): Promise<TagRef> {
        const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: `refs/tags/${tagName}` });
        let commitOid = oid;
        try {
            const obj = await git.readTag({ fs: this.fs, dir: this.dir, oid });
            commitOid = obj.tag.object;
        } catch {
            // Lightweight tag — oid is already the commit
        }
        return { tagName, commitOid };
    }

    /**
     * Lazily loaded `tagName → commitOid` cache with concurrent-load
     * deduplication. Populated by the first call to `_loadAllTagOids`;
     * invalidated on every tag write via `_invalidateTagCache`. While
     * populated, all `tagsPointingAt` / `describeExact` / `showTagRefs`
     * calls hit memory only — no `fs.read`, no parse — so the 2nd-Nth
     * lookup over the same sandbox lifetime is essentially free.
     *
     * Concurrent callers (e.g. `Promise.all([describeExact(), tagsPointingAt()])`
     * on a cold instance) share a single in-flight load instead of each
     * doing the full ~hundreds-of-tags I/O.
     */
    private _tagOidsCache = new MemoizedAsync<Map<string, string>>();

    /** Drop the cached tag→commit map. Call after any write touching tags. */
    private _invalidateTagCache(): void {
        this._tagOidsCache.invalidate();
    }

    /**
     * Lazily loaded current-branch name (the symbolic target of HEAD, or
     * `undefined` when detached) with concurrent-load deduplication. HEAD's
     * branch changes only on a small set of ops (checkout, init, clone, clear,
     * renameBranch), so caching it across the instance lifetime spares every
     * read-side caller — `status`, `diff`, `log`, `reset`, `listBranches`,
     * `getRepoInfo`, the `exec` dispatch — a `.git/HEAD` read on lazy/EFS.
     *
     * Note: a detached HEAD resolves to `undefined`, which MemoizedAsync
     * treats as "not cached", so detached reads simply aren't memoized
     * (correct, just unoptimized — the common case is being on a branch).
     */
    private _currentBranchCache = new MemoizedAsync<string | undefined>();

    /**
     * Lazily loaded raw local branch-name list (`git.listBranches`) with
     * concurrent-load deduplication. The name set changes only when branches
     * are created/deleted/renamed (plus init/clone/clear), not when refs move,
     * so it survives commits/merges/resets untouched.
     */
    private _branchListCache = new MemoizedAsync<string[]>();

    /**
     * Drop the cached current-branch and branch-name list. Call after any
     * write that can change which branches exist or where HEAD points
     * (createBranch, deleteBranch, renameBranch, checkout, init, clone, clear,
     * loadFromDisk).
     */
    private _invalidateBranchCaches(): void {
        this._currentBranchCache.invalidate();
        this._branchListCache.invalidate();
    }

    /**
     * Cached resolver for the current branch. Shared by the public
     * `currentBranch()` and every internal read site so a burst of concurrent
     * callers triggers a single `git.currentBranch` read.
     */
    private _getCurrentBranch(): Promise<string | undefined> {
        return this._currentBranchCache.get(async () => {
            const branch = await git.currentBranch({ fs: this.fs, dir: this.dir });
            return branch || undefined;
        });
    }

    /** Cached resolver for the raw local branch-name list. */
    private _getBranchNames(): Promise<string[]> {
        return this._branchListCache.get(() =>
            git.listBranches({ fs: this.fs, dir: this.dir }),
        );
    }

    /**
     * In-flight dedup for the full status matrix — the single most expensive
     * read (a whole-tree walk + blob hashing). `status`, `diff`, the empty-
     * commit guard, `reset --mixed`, and `statusText` all build the same
     * matrix, and an agent route firing them together (`Promise.all`) would
     * otherwise walk the tree once per call. Unlike the branch/tag caches the
     * result is NEVER retained across settlement — the working tree changes on
     * every write — so only genuinely concurrent callers share the build.
     */
    private _statusMatrixInFlight = new InFlightAsync<Awaited<ReturnType<typeof git.statusMatrix>>>();

    /** Coalesced `git.statusMatrix` (full workdir, no path filter). */
    private _statusMatrix(): Promise<Awaited<ReturnType<typeof git.statusMatrix>>> {
        return this._statusMatrixInFlight.run(() =>
            git.statusMatrix({ fs: this.fs, dir: this.dir }),
        );
    }

    /**
     * Load every tag's commit OID in a single bounded I/O pass, then cache
     * the result for the lifetime of the instance.
     *
     * Strategy:
     *   1. Read `.git/packed-refs` ONCE — one file read covers every packed
     *      tag including annotated tags' peeled commit OIDs (`^<oid>` line).
     *   2. Walk `.git/refs/tags/` for loose tags. For each, read the ref
     *      file directly: lightweight tags store the commit OID, annotated
     *      tags store the tag-object OID and need one `readTag` to peel.
     *   3. Bound parallelism (CONCURRENCY=64). Unbounded `Promise.all` over
     *      thousands of tags drowns the lazy fs cache and races
     *      `_resolveTagToCommit`, leaving the result map incomplete.
     *
     * Cold-path cost (lazy mode, 2700 loose tags, local SSD):
     *   - With peel (default):      ~200ms  (90% of the time = `readTag`
     *                                       failing once per lightweight
     *                                       tag — `readTag` does the full
     *                                       object read before throwing.)
     *   - `skipPeel: true`:         ~13ms   (21× faster — just reads ref
     *                                       files, no object lookups.)
     *
     * `skipPeel` is correct for repos where tags are all lightweight (the
     * default of `git tag <name>`, and how memory-git's own `createTag`
     * works unless `annotated: true` is passed). It returns the wrong OID
     * for annotated tags stored loose, because the file content is the
     * tag-object OID rather than the commit OID. Annotated tags stored in
     * `packed-refs` are unaffected: the peeled `^<commit>` line is
     * inline, no readTag needed.
     *
     * Result Map is cached for the instance lifetime. Cache is invalidated
     * on createTag/deleteTag/loadFromDisk — every code path that can
     * change which tags exist. Calls with different `skipPeel` values
     * share the cache; pass the same value across all calls if precision
     * matters.
     */
    private async _loadAllTagOids(opts: { skipPeel?: boolean } = {}): Promise<Map<string, string>> {
        return this._tagOidsCache.get(() => this._doLoadAllTagOids(opts));
    }

    /** Underlying I/O for `_loadAllTagOids` (cache + dedup live in `_tagOidsCache`). */
    private async _doLoadAllTagOids(opts: { skipPeel?: boolean }): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const gitDir = `${this.dir}/.git`;

        // --- Packed tags: one read of .git/packed-refs ---
        try {
            const text = await this.fs.promises.readFile(`${gitDir}/packed-refs`, 'utf8') as string;
            const lines = text.split('\n');
            // Track the most recent unpeeled tag in case the next line is `^<commit>`
            let pendingAnnotatedTag: string | null = null;
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#')) {
                    pendingAnnotatedTag = null;
                    continue;
                }
                if (line.startsWith('^')) {
                    // Peeled OID for the immediately preceding annotated tag line.
                    if (pendingAnnotatedTag !== null) {
                        result.set(pendingAnnotatedTag, line.slice(1));
                    }
                    pendingAnnotatedTag = null;
                    continue;
                }
                const spaceIdx = line.indexOf(' ');
                if (spaceIdx === -1) { pendingAnnotatedTag = null; continue; }
                const oid = line.slice(0, spaceIdx);
                const refName = line.slice(spaceIdx + 1);
                if (!refName.startsWith('refs/tags/')) { pendingAnnotatedTag = null; continue; }
                const tagName = refName.slice('refs/tags/'.length);
                // Provisional: assume lightweight. A subsequent `^<oid>` line
                // (annotated) will overwrite with the peeled commit OID.
                result.set(tagName, oid);
                pendingAnnotatedTag = tagName;
            }
        } catch {
            // No packed-refs — fresh repo or already pruned.
        }

        // --- Loose tags: walk refs/tags and read each file directly ---
        let looseNames: string[] = [];
        try {
            looseNames = await this._walkRefsTags(`${gitDir}/refs/tags`, '');
        } catch {
            // No refs/tags directory.
        }

        if (looseNames.length > 0) {
            const CONCURRENCY = 64;
            const skipPeel = !!opts.skipPeel;
            for (let i = 0; i < looseNames.length; i += CONCURRENCY) {
                const chunk = looseNames.slice(i, i + CONCURRENCY);
                await Promise.all(chunk.map(async (tagName) => {
                    try {
                        const raw = await this.fs.promises.readFile(
                            `${gitDir}/refs/tags/${tagName}`,
                            'utf8',
                        ) as string;
                        const oid = raw.trim();
                        // Lightweight: file content = commit OID. Annotated:
                        // file content = tag object OID, needs peel via readTag.
                        // skipPeel callers swallow the annotated case in
                        // exchange for ~21× cold-path speedup (see method
                        // docstring).
                        let commitOid = oid;
                        if (!skipPeel) {
                            try {
                                const obj = await git.readTag({ fs: this.fs, dir: this.dir, oid });
                                commitOid = obj.tag.object;
                            } catch {
                                // Lightweight tag — `oid` is already the commit.
                            }
                        }
                        result.set(tagName, commitOid);
                    } catch {
                        // Skip broken/unreadable refs (matches git's silent-drop).
                    }
                }));
            }
        }

        return result;
    }

    /** Recursively walk `.git/refs/tags` returning tag names (nested folders supported). */
    private async _walkRefsTags(absDir: string, prefix: string): Promise<string[]> {
        let entries: string[] = [];
        try {
            entries = await this.fs.promises.readdir(absDir) as string[];
        } catch {
            return [];
        }
        const out: string[] = [];
        await Promise.all(entries.map(async (entry) => {
            const full = `${absDir}/${entry}`;
            const stat = await this.fs.promises.stat(full) as { isDirectory(): boolean };
            if (stat.isDirectory()) {
                const nested = await this._walkRefsTags(full, prefix ? `${prefix}/${entry}` : entry);
                out.push(...nested);
            } else {
                out.push(prefix ? `${prefix}/${entry}` : entry);
            }
        }));
        return out;
    }

    /**
     * Returns the tag that points exactly to the specified ref (equivalent
     * to `git describe --exact-match --tags`).
     *
     * Iterates tags in **reverse-lexicographic order** by default, which on
     * versioned tag schemes (`v0.0.N`) places the most recently created tags
     * near the front — and HEAD usually points at the most recent one. Tags
     * are resolved in parallel chunks; the first matching chunk short-circuits
     * the rest of the scan. On repos with thousands of tags this turns an
     * O(N) serial walk (each tag = 2-3 awaited I/O ops) into a small bounded
     * number of parallel reads.
     *
     * @param ref - Reference to check (default: 'HEAD')
     * @returns Tag name or null if no tag points to that commit
     */
    async describeExact(ref: string = 'HEAD', opts: { skipPeel?: boolean } = {}): Promise<string | null> {
        try {
            const matches = await this.tagsPointingAt(ref, { limit: 1, skipPeel: opts.skipPeel });
            const result = matches[0] ?? null;
            this._logOperation('describeExact', { ref }, { success: true, tag: result });
            return result;
        } catch (error) {
            this._logOperation('describeExact', { ref }, null, error as Error);
            throw error;
        }
    }

    /**
     * Returns all tags that point at the given ref (equivalent to
     * `git tag --points-at <ref>`).
     *
     * Same parallel-with-short-circuit strategy as `describeExact`. When
     * `limit` is set, returns as soon as that many matches are found —
     * useful for "is there any tag here?" checks (limit:1) without scanning
     * the rest of the tag namespace.
     *
     * @param ref - Reference to match against (default: 'HEAD')
     * @param opts.limit - Stop after this many matches. Default: all.
     * @param opts.concurrency - Parallel resolves per chunk. Default 64,
     *   tuned for lazy memfs over EFS where I/O latency dominates and CPU
     *   work per tag is cheap.
     * @returns Matching tag names, in reverse-lex order (newest-first).
     */
    async tagsPointingAt(ref: string = 'HEAD', opts: TagsPointingAtOptions = {}): Promise<string[]> {
        try {
            const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
            const tagOids = await this._loadAllTagOids({ skipPeel: opts.skipPeel });
            const limit = opts.limit != null ? Math.max(0, opts.limit) : Infinity;
            const matches: string[] = [];

            // Iterate the Map directly — newer tags are appended last by git,
            // so we walk in reverse to surface the most recently created
            // match first (the expected one for HEAD on a versioned repo).
            const entries = Array.from(tagOids.entries());
            for (let i = entries.length - 1; i >= 0 && matches.length < limit; i--) {
                const [tagName, commitOid] = entries[i];
                if (commitOid === oid) matches.push(tagName);
            }

            this._logOperation('tagsPointingAt', { ref, opts }, { success: true, count: matches.length, totalTags: tagOids.size });
            return matches;
        } catch (error) {
            this._logOperation('tagsPointingAt', { ref, opts }, null, error as Error);
            throw error;
        }
    }

    /**
     * Lists tag references resolving annotated tags to their target commit OID
     * (equivalent to `git show-ref --tags -d`), with optional pagination and
     * parallelism.
     *
     * Default behavior (no opts) preserves the original return shape: every
     * tag, resolved sequentially-equivalent. New callers should pass
     * `concurrency` to take advantage of the parallel scan; the bench
     * harness shows 5-10× wall-time reduction on repos with thousands of
     * tags in lazy mode.
     *
     * @param opts.limit - Stop after this many resolved tags. Combined with
     *   `reverse`, returns "the last N tags" without scanning the rest.
     * @param opts.reverse - When true, walk tags newest-first (reverse-lex).
     * @param opts.concurrency - Parallel resolves per chunk. Default 1
     *   (serial) to keep legacy semantics; set higher (e.g. 64) for the
     *   parallel path.
     * @returns Tag refs with commit OIDs.
     */
    async showTagRefs(opts: ShowTagRefsOptions = {}): Promise<TagRef[]> {
        try {
            // Short-circuit when caller only needs the first `limit` tags
            // and the cache is cold: pick the names first (cheap — name
            // list comes from listTags/readdir), then resolve only that
            // slice. Avoids paying the full _loadAllTagOids cost (~2700
            // file reads) when the caller wanted N=10.
            if (opts.limit != null && opts.limit < 100 && this._tagOidsCache.peek() === undefined) {
                const names = await this.listTags({ limit: opts.limit, reverse: opts.reverse });
                const result: TagRef[] = [];
                const CONCURRENCY = 64;
                for (let i = 0; i < names.length; i += CONCURRENCY) {
                    const chunk = names.slice(i, i + CONCURRENCY);
                    const resolved = await Promise.all(chunk.map(async (tagName) => {
                        const ref = await this._resolveTagToCommit(tagName);
                        return ref;
                    }));
                    result.push(...resolved);
                }
                this._logOperation('showTagRefs', { ...opts, fastPath: 'short-circuit' }, { success: true, count: result.length });
                return result;
            }

            const tagOids = await this._loadAllTagOids({ skipPeel: opts.skipPeel });
            // listTags returns ascending lex order; preserve that here for
            // back-compat (legacy callers compared against sorted lists).
            const names = Array.from(tagOids.keys()).sort();
            const ordered = opts.reverse ? names.reverse() : names;
            const limit = opts.limit != null ? Math.max(0, opts.limit) : ordered.length;
            const target = ordered.slice(0, limit);
            const result: TagRef[] = target.map((tagName) => ({
                tagName,
                commitOid: tagOids.get(tagName)!,
            }));

            this._logOperation('showTagRefs', { ...opts }, { success: true, count: result.length });
            return result;
        } catch (error) {
            this._logOperation('showTagRefs', { ...opts }, null, error as Error);
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
            const fromOid = await this._resolveAny(fromRef);
            const toOid = await this._resolveAny(toRef);

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
                const resolvedRef = await this._resolveAny(ref);
                const commits = await git.log({
                    fs: this.fs,
                    dir: this.dir,
                    ref: resolvedRef,
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

    /** Returns the history of all operations performed. */
    getOperationsLog(): OperationLogEntry[] {
        return this._log.getEntries();
    }

    /** Clears the operation log (and records the clear itself as an entry). */
    clearOperationsLog(): void {
        this._log.clear();
        this._logOperation('clearOperationsLog', {}, { success: true });
    }

    /** Aggregated counts by operation, success/failure. */
    getOperationsStats(): OperationStats {
        return this._log.getStats();
    }

    /** JSON dump of the log + stats, suitable for storing or feeding back into a model. */
    exportOperationsLog(): string {
        return this._log.exportJson(this.name);
    }

    /**
     * Syncs all changes from memory to disk
     * @param targetPath - Destination path (optional, uses original path if not specified)
     * @param options - Flush options
     * @returns Number of files flushed
     */
    async flush(targetPath: string | null = null, options: FlushOptions = {}): Promise<number> {
        try {
            // Snapshot the dirty paths up front and clear exactly these on
            // success, so any write that lands *during* the async flush stays
            // marked dirty (it may not have been on disk when we walked).
            const persistedThisFlush = [...this._unpersisted];
            const destination = targetPath ? pathNode.resolve(targetPath) : this.realDir;
            if (!destination) {
                throw new Error('No destination path specified and repository was not loaded from disk');
            }

            if (!(await realPathExists(destination))) {
                await fsRealAsync.mkdir(destination, { recursive: true });
            }

            const clean = options.clean === true;
            // Incremental is opt-out as of 3.4. `{force:true}` forces a full
            // rewrite. The instance toggle `tracksDiskSnapshot:false` also
            // forces full rewrites, but silently — that's the user telling us
            // they don't want snapshot bookkeeping at all on this instance.
            const explicitForce = options.force === true;
            const forceFull = explicitForce || !this._tracksDiskSnapshot;

            // If the user skipped the snapshot at load time and didn't ask for
            // a force here, warn that we're falling back to a full rewrite —
            // this is the foot-gun the new default is meant to remove. The
            // warning only fires when (a) tracksDiskSnapshot is on, so the
            // user reasonably expected incremental, and (b) the snapshot is
            // empty *because* of skipSnapshot, not because of a fresh init.
            const fallbackToFull =
                !forceFull &&
                this._tracksDiskSnapshot &&
                this._snapshotSkippedAtLoad &&
                this._diskSnapshot.size === 0;

            if (fallbackToFull) {
                console.warn(
                    '[memory-git] flush(): no disk snapshot is available (loadFromDisk ran with ' +
                    'skipSnapshot), falling back to a full rewrite. Pass {force:true} to silence ' +
                    'this warning, or drop skipSnapshot from loadFromDisk to enable incremental flush.',
                );
            }

            if (forceFull || fallbackToFull) {
                // Lazy mode: walking through `this.fs` would fault every
                // indexed file into memfs just to write it back to disk —
                // pointless work. Use the unwrapped view so the rewrite
                // covers only files the user actually touched in memory.
                const flushFs = this._lazy ? this._rawFs : this.fs;
                const fileCount = await copyMemoryToDisk(flushFs, this.dir, destination);
                // A full flush bypasses the snapshot; subsequent incremental flushes
                // would have a stale baseline, so invalidate it.
                this._diskSnapshot.clear();
                this._snapshotPath = null;
                this._snapshotSkippedAtLoad = false;
                this._logOperation('flush', { targetPath: destination, options }, {
                    success: true,
                    filesFlushed: fileCount,
                    fullRewrite: true,
                    fallbackToFull,
                });
                for (const p of persistedThisFlush) this._unpersisted.delete(p);
                return fileCount;
            }

            // Incremental path: the snapshot is keyed to a specific disk path.
            // Flushing to a different path means we don't know its prior state.
            if (this._snapshotPath !== destination) {
                this._diskSnapshot.clear();
                this._snapshotPath = destination;
            }

            const seen = new Set<string>();
            // Same as the forceFull branch: in lazy mode, the memfs walk
            // should only cover materialized files, not the lazy index.
            const flushFs = this._lazy ? this._rawFs : this.fs;
            const { written, skipped } = await copyMemoryToDiskIncremental(
                flushFs, this.dir, destination, '', this._diskSnapshot, seen,
            );

            let removed = 0;
            if (clean) {
                for (const path of [...this._diskSnapshot.keys()]) {
                    if (seen.has(path)) continue;
                    const fullPath = pathNode.join(destination, path);
                    try {
                        await fsRealAsync.unlink(fullPath);
                        removed += 1;
                    } catch {
                        // Not on disk or unreadable; either way, drop from snapshot.
                    }
                    this._diskSnapshot.delete(path);
                }
            }

            // Lazy-mode tombstones: files the user deleted while they were
            // still unmaterialized never entered memfs, so the snapshot+seen
            // diff above can't catch them. Propagate them to disk now and
            // clear the tombstone set. This fires regardless of `clean` —
            // a tombstone is an explicit user delete, not "noticed missing".
            if (this._lazy && this._lazyState.tombstones.size > 0 && this._snapshotPath === destination) {
                for (const memPath of [...this._lazyState.tombstones]) {
                    const rel = memPath.startsWith(this.dir + '/')
                        ? memPath.slice(this.dir.length + 1)
                        : memPath;
                    const fullPath = pathNode.join(destination, rel);
                    try {
                        await fsRealAsync.unlink(fullPath);
                        removed += 1;
                    } catch {
                        // Already gone on disk — that's fine, the user's
                        // intent (file should not exist) is satisfied.
                    }
                    this._diskSnapshot.delete(rel);
                    this._lazyState.tombstones.delete(memPath);
                }
            }

            this._logOperation('flush', { targetPath: destination, options }, {
                success: true,
                filesFlushed: written,
                written,
                skipped,
                removed,
            });
            for (const p of persistedThisFlush) this._unpersisted.delete(p);
            return written;
        } catch (error) {
            this._logOperation('flush', { targetPath }, null, error as Error);
            throw error;
        }
    }

    /**
     * In-memory garbage collection. Enumerates every OID reachable from refs
     * (branches + remote-tracking branches + tags + HEAD), repacks them into
     * a single new packfile under `.git/objects/pack/`, then deletes the now-
     * redundant loose objects (and, by default, the prior packs they came from).
     *
     * Does NOT touch disk. Call `flush({clean: true})` afterwards to propagate
     * the deletions and the new pack to the on-disk repo. The `clean` flag is
     * required because removing loose objects on disk is a deletion the
     * incremental flush would otherwise skip.
     *
     * Unreachable objects are dropped — equivalent to `git gc --prune=now`.
     * isomorphic-git has no reflog, so there is no grace period.
     *
     * Memory ceiling: `git.packObjects` buffers the whole new pack in RAM
     * before writing. Peak ≈ packed size of all reachable objects.
     */
    async gc(options: GcOptions = {}): Promise<GcResult> {
        this._assertWritable('gc');
        const consolidatePacks = options.consolidatePacks !== false;
        const includeRemoteRefs = options.includeRemoteRefs !== false;
        const includeTags = options.includeTags !== false;

        try {
            const reachable = await this._collectReachableOids({ includeRemoteRefs, includeTags });
            const oids = [...reachable];

            const gitdir = pathNode.posix.join(this.dir, '.git');
            const packDir = pathNode.posix.join(gitdir, 'objects', 'pack');

            // Snapshot pre-existing pack basenames so we can decide what to
            // remove after writing the new one. We list before packObjects
            // because the new pack file lands in the same directory.
            let priorPackBasenames: string[] = [];
            if (consolidatePacks) {
                try {
                    const entries = this.fs.readdirSync(packDir) as string[];
                    priorPackBasenames = entries
                        .filter(n => /^pack-[0-9a-f]+\.pack$/.test(n))
                        .map(n => n.replace(/\.pack$/, ''));
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                }
            }

            let packFilename = '';
            let packSizeBytes = 0;

            if (oids.length > 0) {
                const result = await git.packObjects({
                    fs: this.fs,
                    gitdir,
                    oids,
                    write: true,
                });
                packFilename = result.filename;

                // packObjects writes the .pack but not the .idx. Without an
                // index, isomorphic-git can't read objects from it — so the
                // unlink sweep below would orphan everything in the new pack.
                // indexPack resolves filepath relative to `dir` (working tree),
                // not `gitdir`. Mismatch the prefix and it reads null bytes
                // and crashes inside GitPackIndex.fromPack.
                await git.indexPack({
                    fs: this.fs,
                    dir: this.dir,
                    filepath: pathNode.posix.join('.git', 'objects', 'pack', packFilename),
                });

                try {
                    const stat = this.fs.statSync(pathNode.posix.join(packDir, packFilename));
                    packSizeBytes = (stat as { size?: number }).size ?? 0;
                } catch {
                    // Pack file vanished between write and stat — shouldn't happen
                    // with memfs but don't fail the whole gc over a size report.
                }
            }

            const looseDeleted = this._sweepLooseObjects(gitdir);

            let packsRemoved = 0;
            if (consolidatePacks && oids.length > 0) {
                const newBase = packFilename.replace(/\.pack$/, '');
                for (const base of priorPackBasenames) {
                    if (base === newBase) continue;
                    packsRemoved += this._removePackFamily(packDir, base);
                }
            }

            const result: GcResult = {
                reachableObjects: oids.length,
                looseDeleted,
                packsRemoved,
                packFilename,
                packSizeBytes,
            };
            this._logOperation('gc', { options }, { success: true, ...result });
            return result;
        } catch (error) {
            this._logOperation('gc', { options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Walk every ref (branches, remote-tracking branches, tags, HEAD) and
     * collect every OID reachable through commits, trees, and annotated tags.
     * Memoized in the returned Set — each object is visited at most once.
     * Submodule pointers (TreeEntry.type === 'commit') are not recursed into.
     */
    private async _collectReachableOids(
        opts: { includeRemoteRefs: boolean; includeTags: boolean },
    ): Promise<Set<string>> {
        const reachable = new Set<string>();
        const gitdir = pathNode.posix.join(this.dir, '.git');
        const args = { fs: this.fs, dir: this.dir };

        const tipOids = new Set<string>();
        const addTip = async (ref: string) => {
            try {
                const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
                tipOids.add(oid);
            } catch {
                // Ref vanished or unreachable; ignore.
            }
        };

        for (const b of await git.listBranches(args)) await addTip(`refs/heads/${b}`);
        if (opts.includeRemoteRefs) {
            for (const remote of await git.listRemotes(args)) {
                for (const b of await git.listBranches({ ...args, remote: remote.remote })) {
                    await addTip(`refs/remotes/${remote.remote}/${b}`);
                }
            }
        }
        if (opts.includeTags) {
            for (const t of await git.listTags(args)) await addTip(`refs/tags/${t}`);
        }
        await addTip('HEAD');

        // Peel annotated tags: a tag object points at a commit/tree/blob and
        // both ends must end up in the reachable set.
        const commitFrontier: string[] = [];
        for (const oid of tipOids) {
            const { type } = await git.readObject({ fs: this.fs, gitdir, oid, format: 'parsed' });
            reachable.add(oid);
            if (type === 'tag') {
                const { tag } = await git.readTag({ fs: this.fs, gitdir, oid });
                reachable.add(tag.object);
                if (tag.type === 'commit') commitFrontier.push(tag.object);
                else if (tag.type === 'tree') await this._walkTree(gitdir, tag.object, reachable);
                // blob tag target needs no further walking.
            } else if (type === 'commit') {
                commitFrontier.push(oid);
            } else if (type === 'tree') {
                await this._walkTree(gitdir, oid, reachable);
            }
        }

        // Walk commit graph breadth-first via parents, collecting each commit's
        // tree. Iterative to keep the call stack bounded on long histories.
        const visitedCommits = new Set<string>();
        const queue = [...commitFrontier];
        while (queue.length) {
            const oid = queue.shift()!;
            if (visitedCommits.has(oid)) continue;
            visitedCommits.add(oid);
            reachable.add(oid);
            const { commit } = await git.readCommit({ fs: this.fs, gitdir, oid });
            await this._walkTree(gitdir, commit.tree, reachable);
            for (const parent of commit.parent || []) queue.push(parent);
        }

        return reachable;
    }

    /**
     * Recursively add every tree and blob OID reachable from `treeOid` to
     * `acc`. Submodule entries (type === 'commit') are added as bare OIDs
     * but not followed (the submodule's history lives in another repo).
     */
    private async _walkTree(gitdir: string, treeOid: string, acc: Set<string>): Promise<void> {
        if (acc.has(treeOid)) return;
        acc.add(treeOid);
        const { tree } = await git.readTree({ fs: this.fs, gitdir, oid: treeOid });
        for (const entry of tree) {
            if (entry.type === 'tree') {
                await this._walkTree(gitdir, entry.oid, acc);
            } else if (entry.type === 'blob') {
                acc.add(entry.oid);
            }
            // entry.type === 'commit' ⇒ submodule pointer, intentionally skipped.
        }
    }

    /**
     * Delete every loose object file under `.git/objects/[0-9a-f]{2}/`. Safe
     * to call after `git.packObjects` + `git.indexPack`: any reachable loose
     * object is now duplicated in the new pack, and unreachable ones are
     * dropped (this is the prune step). Returns the file count.
     */
    private _sweepLooseObjects(gitdir: string): number {
        const objectsDir = pathNode.posix.join(gitdir, 'objects');
        let deleted = 0;
        let entries: string[];
        try {
            entries = this.fs.readdirSync(objectsDir) as string[];
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
            throw err;
        }
        for (const name of entries) {
            if (!/^[0-9a-f]{2}$/.test(name)) continue;
            const subdir = pathNode.posix.join(objectsDir, name);
            let files: string[];
            try {
                files = this.fs.readdirSync(subdir) as string[];
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw err;
            }
            for (const file of files) {
                try {
                    this.fs.unlinkSync(pathNode.posix.join(subdir, file));
                    deleted += 1;
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                }
            }
            try {
                this.fs.rmdirSync(subdir);
            } catch {
                // Directory may not be empty if a write raced; leave it.
            }
        }
        return deleted;
    }

    /**
     * Remove every sibling of a pack: `.pack`, `.idx`, `.rev`, `.mtimes`,
     * `.bitmap`. Returns 1 if the `.pack` itself was unlinked (the headline
     * count for `packsRemoved`), 0 otherwise.
     */
    private _removePackFamily(packDir: string, basename: string): number {
        let packRemoved = 0;
        for (const ext of ['.pack', '.idx', '.rev', '.mtimes', '.bitmap']) {
            const filepath = pathNode.posix.join(packDir, basename + ext);
            try {
                this.fs.unlinkSync(filepath);
                if (ext === '.pack') packRemoved = 1;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
        }
        return packRemoved;
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
            const files = listFilesRecursive(this.fs, fullPath, '', includeGit);
            this._logOperation('listFiles', { dir }, { success: true, files: files.length });
            return files;
        } catch (error) {
            this._logOperation('listFiles', { dir }, null, error as Error);
            throw error;
        }
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

            // `git diff HEAD` (single ref, no toRef) is workdir-vs-HEAD in the
            // CLI — route through the matrix path, not the tree-walk path,
            // which would compare HEAD to HEAD and always be empty.
            const isWorkdirVsHead = options.fromRef === 'HEAD' && !options.toRef;

            if (options.fromRef && !isWorkdirVsHead) {
                const toRef = options.toRef ?? 'HEAD';
                const changed = await this.getChangedFiles(options.fromRef, toRef);
                changes = changed.map(c => ({ filepath: c.filepath, status: c.status }));
            } else {
                const matrix = await this._statusMatrix();
                // statusMatrix uses an mtime-second + size shortcut that can
                // miss same-size edits in fast in-memory flows. Re-hash any
                // file we know was touched via memory-git's writeFile/delete
                // path so workdir status is authoritative.
                const verifyMap = options.cached
                    ? new Map<string, number>()
                    : await this._verifyDirtyWorkdir();
                changes = [];
                for (const [filepath, head, workdir, stage] of matrix) {
                    const h = head as number;
                    let w = workdir as number;
                    const s = stage as number;
                    const fp = filepath as string;
                    const overridden = verifyMap.get(fp);
                    if (overridden !== undefined) w = overridden;

                    if (options.cached) {
                        // Only differences between HEAD and index
                        if (h !== s) {
                            changes.push({
                                filepath: fp,
                                status: this._getStatusText(h, w, s)
                            });
                        }
                    } else {
                        if (h !== w || h !== s) {
                            changes.push({
                                filepath: fp,
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

            if (options.filter && options.filter.length > 0) {
                const set = new Set(options.filter.map(c => c.toUpperCase()));
                changes = changes.filter(c => set.has(this._statusToFilterCode(c.status)));
            }

            this._logOperation('diff', { options }, { success: true, changes: changes.length });
            return changes;
        } catch (error) {
            this._logOperation('diff', { options }, null, error as Error);
            throw error;
        }
    }

    /**
     * True if `diff(options)` would return at least one entry — the boolean
     * shape of `git diff --quiet` (exit 0 clean, exit 1 dirty).
     */
    async hasDiff(options: DiffOptions = {}): Promise<boolean> {
        const entries = await this.diff(options);
        return entries.length > 0;
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
                oid: await this._resolveAny(ref),
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
        this._assertWritable('resetFile');
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
        this._assertWritable('stash');
        try {
            // Walk workdir + tracked directly to avoid memfs/statusMatrix cache miss
            const workdirFiles = new Set(listFilesRecursive(this.fs, this.dir));
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
        this._assertWritable('stashPop');
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
        this._assertWritable('clone');
        await primeSafeCompression();
        try {
            this._checkSignal(options.signal);
            this.fs.mkdirSync(this.dir, { recursive: true });

            const { depth, singleBranch, branch, noCheckout, signal, ...rest } = options;

            await this._withSignal(git.clone({
                fs: this.fs,
                http,
                dir: this.dir,
                url,
                depth: depth || undefined,
                singleBranch: singleBranch || false,
                ref: branch,
                noCheckout: noCheckout || false,
                ...rest
            }), signal);

            this.isInitialized = true;
            // After clone, workdir and index are in sync — nothing pending
            this._dirtyFiles.clear();
            // Fresh refs/HEAD from the remote — drop the tag + branch caches.
            this._invalidateTagCache();
            this._invalidateBranchCaches();
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
        this._assertWritable('fetch');
        const options: FetchOptions =
            typeof remoteOrOptions === 'string'
                ? (this._looksLikeUrl(remoteOrOptions)
                    ? { url: remoteOrOptions }
                    : { remote: remoteOrOptions })
                : remoteOrOptions;
        const remoteName = options.remote ?? 'origin';
        const useUrl = options.url ? { url: options.url, remote: remoteName } : { remote: remoteName };

        try {
            this._checkSignal(options.signal);
            // isomorphic-git always updates remote-tracking refs after a
            // fetch, and that pass needs `remote.<name>.fetch` to exist. When
            // we're fetching ad-hoc by URL the user hasn't configured one, so
            // seed the standard default refspec to match `git fetch <url>`.
            if (options.url) {
                await this._ensureDefaultFetchRefspec(remoteName);
            }
            const result = await this._withSignal(git.fetch({
                fs: this.fs,
                http,
                dir: this.dir,
                ...useUrl,
                prune: options.prune,
                tags: options.tags,
                depth: options.depth,
                singleBranch: options.singleBranch,
                ref: options.ref
            }), options.signal);
            // isomorphic-git doesn't write FETCH_HEAD, but real git does on
            // every fetch — and downstream flows rely on `merge FETCH_HEAD`
            // / `diff HEAD FETCH_HEAD` working immediately after.
            this._writeFetchHead(result.fetchHead, result.fetchHeadDescription);
            this._logOperation('fetch', { ...useUrl, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('fetch', { ...useUrl, options }, null, error as Error);
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
        this._assertWritable('pull');
        const options: PullOptions =
            typeof remoteOrOptions === 'string'
                ? (this._looksLikeUrl(remoteOrOptions)
                    ? { url: remoteOrOptions, branch: branch ?? undefined }
                    : { remote: remoteOrOptions, branch: branch ?? undefined })
                : remoteOrOptions;
        const remoteName = options.remote ?? 'origin';
        const useUrl = options.url ? { url: options.url, remote: remoteName } : { remote: remoteName };

        try {
            this._checkSignal(options.signal);
            const currentBranchName = options.branch || await this.currentBranch();
            if (options.url) {
                await this._ensureDefaultFetchRefspec(remoteName);
            }

            await this._withSignal(git.pull({
                fs: this.fs,
                http,
                dir: this.dir,
                ...useUrl,
                ref: currentBranchName,
                author: this.author,
                fastForward: options.fastForward,
                fastForwardOnly: options.fastForwardOnly
            }), options.signal);

            this._logOperation('pull', { ...useUrl, branch: currentBranchName, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('pull', { ...useUrl, branch, options }, null, error as Error);
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
        this._assertWritable('push');
        const options: PushOptions =
            typeof remoteOrOptions === 'string'
                ? (this._looksLikeUrl(remoteOrOptions)
                    ? { url: remoteOrOptions, ref }
                    : { remote: remoteOrOptions, ref })
                : remoteOrOptions;
        const useUrl = options.url ? { url: options.url } : { remote: options.remote ?? 'origin' };

        try {
            this._checkSignal(options.signal);
            const result = await this._withSignal(git.push({
                fs: this.fs,
                http,
                dir: this.dir,
                ...useUrl,
                ref: options.ref,
                remoteRef: options.remoteRef,
                force: options.force,
                delete: options.delete
            }), options.signal);
            this._logOperation('push', { ...useUrl, options }, { success: true });
            return result;
        } catch (error) {
            this._logOperation('push', { ...useUrl, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Heuristic: does the string look like a remote URL (vs a configured
     * remote name)? Matches the common forms accepted by `git fetch`/`git push`:
     * https://, http://, git://, ssh://, file:// schemes, and the SSH
     * shorthand `user@host:path`. Plain identifiers like `origin` return false.
     * @private
     */
    private _looksLikeUrl(s: string): boolean {
        return /^(https?|git|ssh|file):\/\//.test(s) || /^[^/@\s]+@[^:]+:/.test(s);
    }

    /**
     * Writes the standard `+refs/heads/*:refs/remotes/<name>/*` fetch
     * refspec for a remote if none is configured. isomorphic-git refuses
     * to update remote-tracking refs without one, but `git fetch <url>`
     * has no opportunity to configure one beforehand, so we seed it.
     * @private
     */
    private async _ensureDefaultFetchRefspec(remoteName: string): Promise<void> {
        try {
            const existing = await git.getConfigAll({
                fs: this.fs, dir: this.dir, path: `remote.${remoteName}.fetch`,
            });
            if (existing.length === 0) {
                await git.setConfig({
                    fs: this.fs, dir: this.dir,
                    path: `remote.${remoteName}.fetch`,
                    value: `+refs/heads/*:refs/remotes/${remoteName}/*`,
                });
            }
        } catch {
            // Best-effort: if config writes fail the fetch will throw with a
            // clearer error than anything we could rephrase here.
        }
    }

    /**
     * Clears the in-memory filesystem and reinitializes
     */
    async clear(): Promise<boolean> {
        this._assertWritable('clear');
        try {
            this.vol.reset();
            this.isInitialized = false;
            this._stash = [];
            this._dirtyFiles.clear();
            this._unpersisted.clear();
            this._diskSnapshot.clear();
            this._snapshotPath = null;
            this._snapshotSkippedAtLoad = false;
            // Volume wiped — every ref-derived cache is now stale.
            this._invalidateTagCache();
            this._invalidateBranchCaches();
            this._logOperation('clear', {}, { success: true });
            return true;
        } catch (error) {
            this._logOperation('clear', {}, null, error as Error);
            throw error;
        }
    }

    /**
     * Whether the in-memory repository holds changes not yet persisted to
     * disk — working-tree writes OR internal `.git/` writes (commits, tags,
     * refs, index) from any mutating operation. O(1).
     *
     * Under the write-behind / lazy model this is the signal for *when* to
     * `flush()`: it flips `true` the moment a commit or tag is created (even
     * with no working-tree change) and back to `false` once `flush()` has
     * persisted everything. Flushing on a `false` result is a no-op risk;
     * skipping a flush while `true` risks losing that state on a worker crash.
     */
    isDirty(): boolean {
        return this._unpersisted.size > 0;
    }

    /**
     * Snapshot of the repo-relative paths mutated in memory but not yet
     * flushed (e.g. `'src/app.tsx'`, `'.git/refs/tags/v0.0.1'`). Useful for
     * observability/logging. Allocates a copy — prefer `isDirty()` for a
     * cheap boolean check.
     */
    getDirtyPaths(): readonly string[] {
        return [...this._unpersisted];
    }

    /**
     * Records a memfs path mutated in memory but not yet flushed. Invoked by
     * the recording fs wrapper on every write/delete/rename/symlink. Keyed
     * repo-relative (matching the disk snapshot), e.g. `.git/refs/tags/v1`.
     * @private
     */
    private _recordUnpersisted(memPath: string): void {
        const rel = memPath.startsWith(this.dir + '/')
            ? memPath.slice(this.dir.length + 1)
            : memPath;
        this._unpersisted.add(rel);
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
        const matrix = await this._statusMatrix();
        const lines: string[] = [];

        if (options.branch) {
            const current = await this._getCurrentBranch();
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
    async exec(cmd: string, options: ExecOptions = {}): Promise<string> {
        this._checkSignal(options.signal);
        const { handler, args } = this._dispatch(cmd);
        if (!handler) return '';
        return handler.run({ mg: this, signal: options.signal }, args);
    }

    /**
     * Streaming variant of {@link exec}. Yields one logical line at a time.
     *
     * Subcommands with a custom `stream` (log, ls-files, rev-list) yield
     * item-by-item; everything else runs `run()` to completion and yields per
     * `\n`. A trailing empty line is dropped; blank middle lines are kept.
     * The signal is checked before each yield.
     *
     * Example:
     *   for await (const line of mg.execStream('git log --oneline')) {
     *     if (shouldStop()) break;
     *     console.log(line);
     *   }
     */
    async *execStream(cmd: string, options: ExecOptions = {}): AsyncIterable<string> {
        this._checkSignal(options.signal);
        const { handler, args } = this._dispatch(cmd);
        if (!handler) return;
        const ctx = { mg: this, signal: options.signal };
        if (handler.stream) {
            yield* handler.stream(ctx, args);
            return;
        }
        const output = await handler.run(ctx, args);
        if (!output) return;
        const lines = output.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) {
            this._checkSignal(options.signal);
            yield line;
        }
    }

    /**
     * Tokenize a command string and look up the handler. Returns a falsy
     * handler for an empty input (mirrors `git` with no args). Throws on an
     * unknown subcommand.
     * @private
     */
    private _dispatch(cmd: string): { handler: Command | undefined; args: string[] } {
        const tokens = shellParse(cmd).filter((t): t is string => typeof t === 'string');
        if (tokens.length === 0) return { handler: undefined, args: [] };
        if (tokens[0] === 'git') tokens.shift();
        if (tokens.length === 0) return { handler: undefined, args: [] };
        const sub = tokens.shift()!;
        const handler = getCommand(sub);
        if (!handler) throw new Error(`memory-git: '${sub}' is not a supported command`);
        return { handler, args: tokens };
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
            operationsLogged: this._log.size
        };
    }
}
