import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { createFsFromVolume, Volume } from 'memfs';
import { promises as fsRealAsync } from 'fs';
import pathNode from 'path';

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
    /** Patterns of files/folders to ignore */
    ignore?: string[];
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
    [key: string]: unknown;
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
     * Initializes a new repository in memory
     */
    async init(): Promise<boolean> {
        try {
            this.fs.mkdirSync(this.dir, { recursive: true });
            await git.init({ fs: this.fs, dir: this.dir, defaultBranch: 'main' });
            this.isInitialized = true;
            this._logOperation('init', { dir: this.dir }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('init', { dir: this.dir }, null, error as Error);
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
            const ignore = options.ignore || ['node_modules', '.pnpm-store'];
            
            // Create base directory in memory
            this.fs.mkdirSync(this.dir, { recursive: true });
            
            // Copy recursively from disk to memory (async)
            const fileCount = await this._copyToMemoryAsync(this.realDir, this.dir, ignore);
            
            this.isInitialized = true;
            this._logOperation('loadFromDisk', { sourcePath: this.realDir, ignore }, { 
                success: true,
                filesLoaded: fileCount
            });
            return fileCount;
        } catch (error) {
            this._logOperation('loadFromDisk', { sourcePath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Copies files from real disk to memory filesystem (async)
     * @private
     */
    private async _copyToMemoryAsync(realPath: string, memoryPath: string, ignore: string[] = []): Promise<number> {
        const entries = await fsRealAsync.readdir(realPath, { withFileTypes: true });
        
        // Process entries in parallel for better performance
        const promises = entries.map(async (entry) => {
            // Check if should ignore
            if (ignore.includes(entry.name)) return 0;
            
            const realEntryPath = pathNode.join(realPath, entry.name);
            const memoryEntryPath = pathNode.posix.join(memoryPath, entry.name);
            
            if (entry.isDirectory()) {
                this.fs.mkdirSync(memoryEntryPath, { recursive: true });
                return await this._copyToMemoryAsync(realEntryPath, memoryEntryPath, ignore);
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
            this._logOperation('deleteFile', { filepath }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteFile', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Adds file(s) to the staging area
     * @param filepath - Relative file path(s)
     */
    async add(filepath: string | string[]): Promise<boolean> {
        try {
            const files = Array.isArray(filepath) ? filepath : [filepath];
            
            for (const file of files) {
                await git.add({ fs: this.fs, dir: this.dir, filepath: file });
            }
            
            this._logOperation('add', { filepath: files }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('add', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Removes file(s) from the staging area and working tree
     * @param filepath - Relative file path
     */
    async remove(filepath: string): Promise<boolean> {
        try {
            await git.remove({ fs: this.fs, dir: this.dir, filepath });
            this._logOperation('remove', { filepath }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('remove', { filepath }, null, error as Error);
            throw error;
        }
    }

    /**
     * Creates a commit with staged changes
     * @param message - Commit message
     * @returns SHA of the created commit
     */
    async commit(message: string): Promise<string> {
        try {
            const sha = await git.commit({
                fs: this.fs,
                dir: this.dir,
                message,
                author: this.author
            });
            
            this._logOperation('commit', { message }, { success: true, sha });
            return sha;
        } catch (error) {
            this._logOperation('commit', { message }, null, error as Error);
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
     * @param depth - Number of commits to return
     * @returns List of commits
     */
    async log(depth: number = 10): Promise<CommitInfo[]> {
        try {
            const commits = await git.log({ fs: this.fs, dir: this.dir, depth });
            
            const result = commits.map(commit => ({
                sha: commit.oid,
                message: commit.commit.message,
                author: commit.commit.author.name,
                email: commit.commit.author.email,
                timestamp: new Date(commit.commit.author.timestamp * 1000).toISOString()
            }));
            
            this._logOperation('log', { depth }, { success: true, commits: result.length });
            return result;
        } catch (error) {
            this._logOperation('log', { depth }, null, error as Error);
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
     */
    async deleteBranch(branchName: string): Promise<boolean> {
        try {
            await git.deleteBranch({ fs: this.fs, dir: this.dir, ref: branchName });
            this._logOperation('deleteBranch', { branchName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('deleteBranch', { branchName }, null, error as Error);
            throw error;
        }
    }

    /**
     * Switches to a branch
     * @param branchName - Branch name
     */
    async checkout(branchName: string): Promise<boolean> {
        try {
            await git.checkout({ fs: this.fs, dir: this.dir, ref: branchName });
            this._logOperation('checkout', { branchName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('checkout', { branchName }, null, error as Error);
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
     */
    async merge(theirBranch: string): Promise<MergeResult> {
        try {
            const result = await git.merge({
                fs: this.fs,
                dir: this.dir,
                theirs: theirBranch,
                author: this.author
            });
            
            this._logOperation('merge', { theirBranch }, { success: true, ...result });
            return result;
        } catch (error) {
            this._logOperation('merge', { theirBranch }, null, error as Error);
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
     * Creates a tag
     * @param tagName - Tag name
     * @param ref - Reference (commit SHA or branch)
     */
    async createTag(tagName: string, ref: string = 'HEAD'): Promise<boolean> {
        try {
            await git.tag({ fs: this.fs, dir: this.dir, ref: tagName, object: ref });
            this._logOperation('createTag', { tagName, ref }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('createTag', { tagName, ref }, null, error as Error);
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
    async resolveRef(ref: string = 'HEAD', options?: { short?: boolean }): Promise<string> {
        try {
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
            const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
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
    async rename(oldPath: string, newPath: string): Promise<boolean> {
        try {
            const fullOldPath = pathNode.posix.join(this.dir, oldPath);
            const fullNewPath = pathNode.posix.join(this.dir, newPath);

            const content = this.fs.readFileSync(fullOldPath);

            const newDir = pathNode.posix.dirname(fullNewPath);
            this.fs.mkdirSync(newDir, { recursive: true });

            this.fs.writeFileSync(fullNewPath, content as Buffer);
            this.fs.unlinkSync(fullOldPath);

            await git.remove({ fs: this.fs, dir: this.dir, filepath: oldPath });
            await git.add({ fs: this.fs, dir: this.dir, filepath: newPath });

            this._logOperation('rename', { oldPath, newPath }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('rename', { oldPath, newPath }, null, error as Error);
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
     * Gets the diff between working tree and HEAD
     * @returns List of modified files
     */
    async diff(): Promise<DiffEntry[]> {
        try {
            const changes: DiffEntry[] = [];
            const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
            
            for (const [filepath, head, workdir, stage] of statusMatrix) {
                if (head !== workdir || head !== stage) {
                    changes.push({
                        filepath: filepath as string,
                        status: this._getStatusText(head as number, workdir as number, stage as number)
                    });
                }
            }
            
            this._logOperation('diff', {}, { 
                success: true, 
                changes: changes.length 
            });
            
            return changes;
        } catch (error) {
            this._logOperation('diff', {}, null, error as Error);
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
            const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
            const stashedFiles: StashedFile[] = [];
            
            for (const [filepath, head, workdir] of statusMatrix) {
                if (workdir === 2 || workdir === 0) {
                    const fullPath = pathNode.posix.join(this.dir, filepath as string);
                    try {
                        const content = this.fs.readFileSync(fullPath);
                        stashedFiles.push({ 
                            filepath: filepath as string, 
                            content: content as Buffer, 
                            wasNew: head === 0 
                        });
                    } catch {
                        // Deleted file
                        stashedFiles.push({ filepath: filepath as string, deleted: true });
                    }
                }
            }
            
            this._stash.push(stashedFiles);
            
            // Reset to HEAD
            for (const file of stashedFiles) {
                const fullPath = pathNode.posix.join(this.dir, file.filepath);
                if (file.deleted) {
                    // Restore deleted file
                    try {
                        await git.checkout({
                            fs: this.fs,
                            dir: this.dir,
                            filepaths: [file.filepath],
                            force: true
                        });
                    } catch {
                        // Ignore if didn't exist
                    }
                } else if (file.wasNew) {
                    // Remove new file
                    try {
                        this.fs.unlinkSync(fullPath);
                    } catch {
                        // Ignore
                    }
                } else {
                    // Restore modified file
                    await git.checkout({
                        fs: this.fs,
                        dir: this.dir,
                        filepaths: [file.filepath],
                        force: true
                    });
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
            
            await git.clone({
                fs: this.fs,
                http,
                dir: this.dir,
                url,
                depth: options.depth || undefined,
                singleBranch: options.singleBranch || false,
                ...options
            });
            
            this.isInitialized = true;
            this._logOperation('clone', { url, options }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('clone', { url, options }, null, error as Error);
            throw error;
        }
    }

    /**
     * Fetches from a remote
     * @param remote - Remote name (default: 'origin')
     */
    async fetch(remote: string = 'origin'): Promise<boolean> {
        try {
            await git.fetch({
                fs: this.fs,
                http,
                dir: this.dir,
                remote
            });
            this._logOperation('fetch', { remote }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('fetch', { remote }, null, error as Error);
            throw error;
        }
    }

    /**
     * Pulls from a remote
     * @param remote - Remote name (default: 'origin')
     * @param branch - Branch name
     */
    async pull(remote: string = 'origin', branch: string | null = null): Promise<boolean> {
        try {
            const currentBranchName = branch || await this.currentBranch();
            
            await git.pull({
                fs: this.fs,
                http,
                dir: this.dir,
                remote,
                ref: currentBranchName,
                author: this.author
            });
            
            this._logOperation('pull', { remote, branch: currentBranchName }, { success: true });
            return true;
        } catch (error) {
            this._logOperation('pull', { remote, branch }, null, error as Error);
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
