/**
 * Public type surface of memory-git.
 *
 * All interfaces and type aliases used in the MemoryGit API live here.
 * Re-exported from `memory-git` (the main entry) for direct consumer use.
 */

export interface Author {
    name: string;
    email: string;
    /**
     * Unix seconds. When unset on an Author passed to commit/merge/createTag,
     * the underlying call stamps `Date.now()/1000` at write time — making the
     * resulting OID non-reproducible. Set this (or the surrounding op's
     * `date`) for byte-identical interop vs native git under fixed
     * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`.
     */
    timestamp?: number;
    /**
     * Minutes west of UTC (matches `Date.prototype.getTimezoneOffset()`).
     * iso-git serializes this as `±HHMM` with the sign flipped (positive →
     * `-`). Defaults to the local timezone at write time when unset; pin for
     * reproducibility.
     */
    timezoneOffset?: number;
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
    /**
     * Parent commit OIDs in the same order they appear in the commit object.
     * Empty for root commits; length ≥ 2 for merge commits. Optional only for
     * backwards-compatibility — populated by `log()`/`show()` since the
     * `Merge:` formatter parity work.
     */
    parents?: string[];
    /** Tree OID this commit points at. Optional for back-compat. */
    tree?: string;
    /**
     * Committer info. Distinct from author for amends, cherry-picks, rebases.
     * Optional for back-compat; populated by `log()`/`show()`.
     */
    committer?: { name: string; email: string; timestamp: string; tzMin?: number };
    /**
     * Author timezone offset, in minutes west of UTC (matches the JS
     * `getTimezoneOffset` and iso-git's `timezoneOffset` convention). Used to
     * format dates in the native git `Thu Jan 1 00:00:00 2026 +0000` shape.
     * Optional for back-compat.
     */
    authorTzMin?: number;
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
    /**
     * Per-area split of the resident bytes, so callers can see where an
     * instance's memory actually goes: working tree vs the git object store,
     * and within `.git` whether it's packs or loose objects. Computed by a
     * cheap stat walk over the in-memory volume — no Volume clone. Binary
     * (Buffer) content is counted by its real byte length.
     */
    breakdown: {
        workingTree: { files: number; bytes: number };
        git: {
            files: number;
            bytes: number;
            /** Bytes in `.git/objects/pack/`. */
            packBytes: number;
            /** Bytes in loose objects `.git/objects/<2hex>/<rest>`. */
            looseBytes: number;
            /** Count of loose objects (each is a separate memfs node). */
            looseObjects: number;
        };
    };
}

export interface LoadFromDiskOptions {
    /** Extra patterns to ignore (added on top of .gitignore). Treated as gitignore-style patterns. */
    ignore?: string[];
    /** Respect .gitignore files in the source tree (default: true). The repo's own .git/ is always loaded regardless. */
    respectGitignore?: boolean;
    /** Also respect nested .gitignore files in subdirectories (default: true; requires respectGitignore). */
    nestedGitignore?: boolean;
    /**
     * Skip building the (size, mtime, hash) snapshot during this load (default: false).
     * Saves the hashing cost when you know you'll never call `flush` against the same
     * destination, but a subsequent `flush` without `{force:true}` will warn and fall
     * back to a full write because it has no baseline to diff against.
     */
    skipSnapshot?: boolean;
    /**
     * @deprecated Snapshot is built by default since 3.4. Accepted as a no-op alias
     * so existing callers keep working. Pass `{skipSnapshot:true}` to opt out.
     */
    incremental?: boolean;
    /**
     * Force `add('.')` to stage the entire loaded working tree after this load
     * (default: false). By default a load of a *committed* checkout seeds
     * nothing — the in-memory index already matches the worktree, so `add('.')`
     * is a no-op until something is written in memory (writes are tracked
     * automatically, including builds writing through `toJustBashFs(mg)`). A
     * fresh import with an unborn HEAD always seeds the whole tree regardless of
     * this flag. Set `true` only when loading a checkout with pre-existing
     * unstaged/untracked working-tree state you want `add('.')` to pick up.
     */
    stageWorkingTree?: boolean;
}

export interface FlushOptions {
    /** Remove files on disk that no longer exist in the snapshot (default: false). Ignored when `force:true` or no snapshot is available. */
    clean?: boolean;
    /**
     * Force a full rewrite of every file regardless of the snapshot (default: false).
     * Use when you know the destination drifted out-of-band and you want to
     * overwrite it wholesale. Invalidates the snapshot afterwards.
     */
    force?: boolean;
    /**
     * @deprecated Incremental flush is the default since 3.4. Accepted as a no-op alias
     * so existing callers keep working. Pass `{force:true}` to force a full rewrite.
     */
    incremental?: boolean;
}

export interface MemoryGitOptions {
    /**
     * Whether this instance maintains a per-file disk snapshot used to make
     * `loadFromDisk` and `flush` incremental (default: true). Set to `false` to
     * permanently opt out: `loadFromDisk` skips the hash pass and `flush` always
     * does a full rewrite — equivalent to passing `skipSnapshot`/`force` on
     * every call, but silently (no warning on flush). Per-call `skipSnapshot`
     * and `force` still apply when this is true.
     */
    tracksDiskSnapshot?: boolean;
    /**
     * Defer reading file contents until first access (default: false). When
     * true, `loadFromDisk` only walks the source tree to learn what exists
     * (stat + readdir) and records each path in a lazy index. Files are
     * materialized into the in-memory volume the first time anything reads
     * them — through any of the fs APIs isomorphic-git or this library
     * touches. Untouched files never load.
     *
     * Trade-offs: random-access reads (`show HEAD:path`, `cat-file`, ref
     * lookups) get the full saving. Operations that iterate the workdir
     * (`add('.')`, `status`) still materialize everything they walk. Pack
     * files have no internal seek — once any object inside is read, the
     * whole pack loads. Materialized files participate in the disk snapshot
     * normally; `flush()` only writes files that were actually changed in
     * memory.
     */
    lazy?: boolean;
    /**
     * Cap the in-memory operation log at this many entries (default: unbounded).
     * The log grows by one small entry per operation and is never trimmed
     * otherwise, so long-lived/pooled instances accumulate it indefinitely.
     * Set a bound (e.g. 10_000) to keep it a ring buffer — the oldest entries
     * are dropped once the cap is exceeded. `getOperationsLog()`/`exportJson()`
     * then return only the retained tail.
     */
    maxLogEntries?: number;
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
    /** Abort the clone in flight. Throws AbortError on abort. */
    signal?: AbortSignal;
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
    /** Recurse into directories — required to remove a tracked dir (git rm -r) */
    recursive?: boolean;
    /** Exit successfully when a pathspec matches nothing (git rm --ignore-unmatch) */
    ignoreUnmatch?: boolean;
}

export interface LsFilesOptions {
    /**
     * Limit output to files matching these pathspecs. A pathspec matches a file
     * by exact path or as a leading directory (e.g. `dist` matches `dist/x.js`).
     * Empty/`.` matches everything. Glob/wildcard pathspecs are not supported.
     */
    pathspecs?: string[];
    /** List files in the index — the default when no other selector is given (git ls-files -c). */
    cached?: boolean;
    /**
     * List untracked files (git ls-files -o). Ignored files are always excluded,
     * i.e. this behaves as if `--exclude-standard` were always set; the
     * {@link excludeStandard} flag is therefore accepted but a no-op.
     */
    others?: boolean;
    /** List files with unstaged modifications, including unstaged deletions (git ls-files -m). */
    modified?: boolean;
    /** List files deleted from the working tree but still in the index (git ls-files -d). */
    deleted?: boolean;
    /** Accepted for CLI compatibility; ignored files are always excluded regardless. */
    excludeStandard?: boolean;
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
    /**
     * Conflict resolution preference (`--strategy-option=ours|theirs`).
     * Auto-resolves every conflict by keeping our side or their side wholesale,
     * with no conflict markers.
     */
    strategy?: 'ours' | 'theirs';
    /** Allow merging two branches with no common ancestor (--allow-unrelated-histories) */
    allowUnrelatedHistories?: boolean;
    /**
     * Override author for the merge commit (mirrors `CommitOptions.author`).
     * Without this, the configured `mg.author` is used. Pass an `Author` with
     * `timestamp`/`timezoneOffset` populated for byte-identical reproducibility
     * vs `git merge` under fixed `GIT_AUTHOR_DATE`.
     */
    author?: Author;
    /**
     * Override committer for the merge commit. Defaults to `options.author`
     * (or `mg.author`) when omitted, matching git's behavior under
     * `GIT_COMMITTER_*` falling back to `GIT_AUTHOR_*`.
     */
    committer?: Author;
    /**
     * Override timestamp for both author and committer (ms since epoch or
     * Date). Mirrors `CommitOptions.date`. Without this and without
     * `timestamp` on `author`/`committer`, the merge commit is stamped with
     * `Date.now()` in the local timezone — so reproducible builds must pin
     * this to get byte-identical OIDs vs `git merge`.
     */
    date?: Date | number;
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
    /**
     * Override the tagger for an annotated tag (mirrors `CommitOptions.author`
     * for commits). Without this, the configured `mg.author` is used. Pass
     * `timestamp`/`timezoneOffset` for byte-identical reproducibility vs
     * `git tag -a` under fixed `GIT_COMMITTER_DATE`.
     */
    tagger?: Author;
    /**
     * Override timestamp for the tagger (ms since epoch or Date). Without this
     * the annotated tag object is stamped with `Date.now()` in the local
     * timezone, producing a non-deterministic tag OID. Lightweight tags
     * (default) carry no tagger and are unaffected.
     */
    date?: Date | number;
}

export interface RenameOptions {
    /** Overwrite destination if it exists (git mv -f) */
    force?: boolean;
}

export interface FetchOptions {
    /** Remote name (looked up in git config). Mutually exclusive with `url`. */
    remote?: string;
    /**
     * Direct remote URL — bypasses config and fetches ad-hoc, matching
     * `git fetch <url>`. Takes precedence over `remote` if both are set.
     */
    url?: string;
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
    /** Abort the fetch in flight. Throws AbortError on abort. */
    signal?: AbortSignal;
}

export interface PullOptions {
    /** Remote name. Mutually exclusive with `url`. */
    remote?: string;
    /**
     * Direct remote URL — bypasses config and pulls ad-hoc, matching
     * `git pull <url> <branch>`. Takes precedence over `remote` if both are set.
     */
    url?: string;
    /** Branch to pull */
    branch?: string;
    /** Refuse to merge unless fast-forward is possible (--ff-only) */
    fastForwardOnly?: boolean;
    /** Only fast-forward (no merge commit) */
    fastForward?: boolean;
    /** Abort the pull in flight. Throws AbortError on abort. */
    signal?: AbortSignal;
}

export interface PushOptions {
    /** Remote name (default: 'origin'). Mutually exclusive with `url`. */
    remote?: string;
    /**
     * Direct remote URL — bypasses config and pushes ad-hoc, matching
     * `git push <url>`. Takes precedence over `remote` if both are set.
     */
    url?: string;
    /** Ref to push (default: current branch) */
    ref?: string;
    /** Remote ref name */
    remoteRef?: string;
    /** Force push (--force) */
    force?: boolean;
    /** Delete the remote ref */
    delete?: boolean;
    /** Abort the push in flight. Throws AbortError on abort. */
    signal?: AbortSignal;
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

/** Single-letter status codes accepted by `git diff --diff-filter` */
export type DiffFilterCode = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X' | 'B';

export interface DiffOptions {
    /** Compare staged changes against HEAD (git diff --cached) */
    cached?: boolean;
    /** Compare from this ref. If set with toRef, behaves like git diff <from> <to> */
    fromRef?: string;
    /** Compare to this ref. Default: working tree (or HEAD when cached) */
    toRef?: string;
    /** Restrict diff to these paths */
    paths?: string[];
    /** Keep only entries whose status matches one of these codes (--diff-filter=ACMR) */
    filter?: DiffFilterCode[];
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

export interface RefRow {
    /** OID the ref points at. For annotated tags this is the tag-object OID. */
    oid: string;
    /** Full ref name: refs/heads/main, refs/tags/v1, refs/remotes/origin/main, etc. */
    ref: string;
    /** Peeled commit OID, present only for annotated tags. */
    peeled?: string;
}

export interface ShowRefsOptions {
    /** Include local branches (refs/heads/*). */
    heads?: boolean;
    /** Include tags (refs/tags/*). */
    tags?: boolean;
    /** Include remote-tracking branches (refs/remotes/*). */
    remotes?: boolean;
}

export interface TagRef {
    tagName: string;
    /**
     * Peeled commit OID. For lightweight tags this equals `refOid`; for
     * annotated tags it's the OID of the commit the tag *object* points at.
     * What `tagsPointingAt`/`describeExact` match against.
     */
    commitOid: string;
    /**
     * OID the ref itself stores — the tag-object OID for annotated tags,
     * the commit OID for lightweight tags. What `git show-ref` emits by
     * default (vs. `commitOid`, which it only emits under `-d`). Always
     * populated.
     */
    refOid: string;
}

export interface ListTagsOptions {
    /** Maximum tags to return. Default: all. */
    limit?: number;
    /** Number of tags to skip before applying `limit`. Default: 0. */
    offset?: number;
    /** Return the slice in reverse-lexicographic (newest names first) order. */
    reverse?: boolean;
}

export interface ShowTagRefsOptions {
    /** Maximum tag refs to resolve and return. Default: all. */
    limit?: number;
    /** When true, walk tags newest-first (reverse-lex). */
    reverse?: boolean;
    /**
     * Per-chunk parallelism for legacy resolveRef paths. Ignored by the
     * packed-refs fast path (which is a single read). Default: 1.
     */
    concurrency?: number;
    /**
     * Skip the `readTag` peel step for loose tags. ~21× faster on repos
     * with thousands of loose lightweight tags, but returns the
     * tag-object OID (not the commit OID) for annotated loose tags. Safe
     * for repos where tags are all lightweight (memory-git's default).
     * Packed annotated tags are unaffected — their peeled commit OID is
     * already inline in `packed-refs`.
     */
    skipPeel?: boolean;
}

export interface TagsPointingAtOptions {
    /** Stop after this many matches are found. Default: all matches. */
    limit?: number;
    /**
     * Per-chunk parallelism for the legacy slow path. Ignored by the
     * packed-refs fast path. Default: 64.
     */
    concurrency?: number;
    /**
     * Skip the `readTag` peel step for loose tags. See ShowTagRefsOptions
     * for the precision/perf tradeoff.
     */
    skipPeel?: boolean;
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
    /**
     * Range form: commits reachable from `to` but not from `from`. Mirrors
     * `git rev-list <from>..<to>`. Either side accepts anything resolveRef
     * understands (HEAD, branch/tag, short SHA, FETCH_HEAD…). When set,
     * `all` and `ref` are ignored. Pair with the `revListCount` method (or
     * `git rev-list --count A..B`) when you only need the size.
     */
    range?: { from: string; to: string };
}

export interface GcOptions {
    /**
     * Consolidate existing packfiles into the new pack and remove the old
     * `.pack`/`.idx`/`.rev`/`.mtimes`/`.bitmap` files (default: true). When
     * false, only loose objects are repacked and prior packs are left in place.
     */
    consolidatePacks?: boolean;
    /** Include remote-tracking refs (refs/remotes/) in the reachability set (default: true). */
    includeRemoteRefs?: boolean;
    /** Include tags (annotated + lightweight) in the reachability set (default: true). */
    includeTags?: boolean;
}

export interface GcResult {
    /** Distinct OIDs walked from refs and packed into the new pack. */
    reachableObjects: number;
    /** Loose object files removed from `.git/objects/[0-9a-f]{2}/`. */
    looseDeleted: number;
    /** Stale pack files removed (counts each `.pack`; sibling `.idx`/`.rev`/… removed with it but not counted separately). */
    packsRemoved: number;
    /** Filename of the new pack (e.g. `pack-<sha>.pack`). Empty when there were no reachable objects. */
    packFilename: string;
    /** Byte size of the new pack as written to memfs. */
    packSizeBytes: number;
}

/** Options accepted by exec/execStream */
export interface ExecOptions {
    /** Abort the in-flight operation. Throws AbortError on abort. */
    signal?: AbortSignal;
}

/** Callback type for the operation-log observer */
export type OperationListener = (op: OperationLogEntry) => void;
