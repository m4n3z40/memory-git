/**
 * Public type surface of memory-git.
 *
 * All interfaces and type aliases used in the MemoryGit API live here.
 * Re-exported from `memory-git` (the main entry) for direct consumer use.
 */

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
    /** Abort the fetch in flight. Throws AbortError on abort. */
    signal?: AbortSignal;
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
    /** Abort the pull in flight. Throws AbortError on abort. */
    signal?: AbortSignal;
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

/** Options accepted by exec/execStream */
export interface ExecOptions {
    /** Abort the in-flight operation. Throws AbortError on abort. */
    signal?: AbortSignal;
}

/** Callback type for the operation-log observer */
export type OperationListener = (op: OperationLogEntry) => void;
