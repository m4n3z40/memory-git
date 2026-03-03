# MemoryGit

In-memory Git implementation for test environments. All git operations run in memory — no process spawns, no disk IO — and sync to disk only when you explicitly call `flush()`.

## Features

- **Zero IO during git operations** — all operations are done in memory
- **Isolated volumes** — each instance has its own independent filesystem, safe for parallel tests
- **Non-blocking** — real disk operations use `fs.promises` to avoid blocking the event loop
- **Controlled flush** — syncs to disk only when you decide
- **Operation logging** — records all operations with timestamps and stats
- **Complete API** — init, add, commit, branch, merge, tags, reset, stash, and more

## Installation

```bash
npm install memory-git
# or
pnpm add memory-git
```

## Basic Usage

```typescript
import { MemoryGit } from 'memory-git';

const memGit = new MemoryGit('my-project');
memGit.setAuthor('Your Name', 'email@example.com');

await memGit.init();
await memGit.writeFile('README.md', '# My Project');
await memGit.add('README.md');
await memGit.commit('Initial commit');

// Sync to disk only when ready
await memGit.flush('./output-directory');
```

## Loading an Existing Repository

```typescript
const memGit = new MemoryGit('my-repo');
await memGit.loadFromDisk('./my-existing-repo', {
    ignore: ['node_modules', 'dist']
});

await memGit.writeFile('CHANGELOG.md', '# Changelog');
await memGit.add('CHANGELOG.md');
await memGit.commit('docs: add changelog');

await memGit.flush(); // writes back to original path
```

## Migration from v1 to v2

**Breaking change:** each instance now has its own isolated filesystem volume. In v1, all instances shared a global `memfs` volume, causing interference.

```typescript
// v2 — instances are fully isolated
const g1 = new MemoryGit('a');
const g2 = new MemoryGit('b'); // independent volume, no interference
```

## API

### Setup

| Method | Description |
|--------|-------------|
| `new MemoryGit(name?)` | Creates instance with isolated volume |
| `setAuthor(name, email)` | Sets commit author |
| `init()` | Initializes empty repository |
| `loadFromDisk(path, options?)` | Loads repository from disk |
| `clone(url, options?)` | Clones remote repository |
| `clear()` | Resets memory state |
| `flush(targetPath?)` | Syncs memory to disk |

### File Operations

| Method | Description |
|--------|-------------|
| `writeFile(filepath, content)` | Writes file |
| `readFile(filepath)` | Reads file |
| `deleteFile(filepath)` | Deletes file |
| `fileExists(filepath)` | Checks existence |
| `listFiles(dir?, includeGit?)` | Lists files in working tree |
| `rename(oldPath, newPath)` | Moves file and stages change (`git mv`) |

### Staging and Commits

| Method | Description |
|--------|-------------|
| `add(filepath)` | Stages file(s) |
| `remove(filepath)` | Unstages and removes from working tree |
| `commit(message)` | Creates commit, returns SHA |
| `status()` | Returns `FileStatus[]` |
| `diff()` | Returns changed files vs HEAD |

### Refs and History

| Method | Description |
|--------|-------------|
| `log(depth?)` | Returns `CommitInfo[]` |
| `resolveRef(ref?, options?)` | Resolves ref to OID (`git rev-parse`); `short: true` returns 7-char hash |
| `revList(options?)` | Lists commit OIDs (`git rev-list`) |
| `readFileAtRef(filepath, ref?, options?)` | Reads file at a ref; `encoding: 'buffer'` returns `Buffer` |
| `listTrackedFiles(ref?)` | Lists tracked files at ref (`git ls-tree -r`) |
| `getChangedFiles(fromRef, toRef?, options?)` | Diffs two refs, supports `filter` by status |
| `reset(ref?, options?)` | Resets to ref — modes: `'soft'` \| `'mixed'` (default) \| `'hard'` |
| `resetFile(filepath)` | Resets single file to HEAD |

### Branches

| Method | Description |
|--------|-------------|
| `createBranch(name)` | Creates branch |
| `deleteBranch(name)` | Deletes branch |
| `checkout(name)` | Switches branch |
| `listBranches()` | Returns `BranchInfo[]` |
| `currentBranch()` | Returns current branch name |
| `merge(branch)` | Merges branch |

### Tags

| Method | Description |
|--------|-------------|
| `createTag(name, ref?)` | Creates lightweight tag |
| `listTags()` | Lists tag names |
| `deleteTag(name)` | Deletes tag (`git tag -d`) |
| `describeExact(ref?)` | Returns tag at exact ref (`git describe --exact-match --tags`) |
| `showTagRefs()` | Returns `TagRef[]` with resolved commit OIDs |

### Remotes

| Method | Description |
|--------|-------------|
| `addRemote(name, url)` | Adds remote |
| `deleteRemote(name)` | Removes remote |
| `listRemotes()` | Returns `RemoteInfo[]` |
| `fetch(remote?)` | Fetches from remote |
| `pull(remote?, branch?)` | Pulls from remote |

### Stash

| Method | Description |
|--------|-------------|
| `stash()` | Saves changes to stash |
| `stashPop()` | Restores from stash |
| `stashList()` | Returns stash count |

### Observability

| Method | Description |
|--------|-------------|
| `getOperationsLog()` | All recorded operations |
| `getOperationsStats()` | Aggregated stats by operation |
| `exportOperationsLog()` | Exports log as JSON string |
| `clearOperationsLog()` | Clears the log |
| `getMemoryUsage()` | Estimated memory usage |
| `getRepoInfo()` | Repository summary |

## TypeScript

All types are exported:

```typescript
import {
    MemoryGit,
    CommitInfo, FileStatus, BranchInfo, RemoteInfo,
    TagRef, ChangedFile, RevListOptions,
    ResetMode, ResetOptions, DiffEntry,
    MergeResult, MemoryUsage, RepoInfo
} from 'memory-git';
```

## Benchmark

Run `pnpm run benchmark` to compare against the real git CLI:

| Metric | Git CLI | MemoryGit |
|--------|---------|-----------|
| Overhead per call | 3.63ms | 0.03ms |
| Init | 15ms | 2ms |
| Commit | 8ms | 4ms |
| Log (50x) | 232ms | 161ms |

The main gain is eliminating process spawn overhead (~3.6ms per call). MemoryGit is ideal for test suites that call git repeatedly.

## Dependencies

- [isomorphic-git](https://isomorphic-git.org/) — pure JS Git implementation
- [memfs](https://github.com/streamich/memfs) — in-memory filesystem

## License

MIT
