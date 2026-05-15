# MemoryGit

In-memory Git for AI agents, slow filesystems (EFS/NFS), and test harnesses. Run `git status`, `git commit -m "..."`, and every other common git command **as bash-like strings**, against an in-memory repo — no subprocess, no disk side effects until you call `flush()`.

```typescript
const mg = new MemoryGit();
await mg.init();
await mg.writeFile('README.md', '# hello');
await mg.exec('git add .');
await mg.exec('git commit -m "first"');
await mg.exec('git log --oneline');  // → "a1b2c3d first"
```

## Why this exists

AI coding agents and CI pipelines constantly call `git`. The standard path — `child_process.exec('git status')` against a `.git/` directory on disk — has real costs:

- **~3-4ms of subprocess overhead per call**, dominating runtime for fast operations.
- **`.git/` is a worst-case workload for slow filesystems.** A repo's `.git/objects/` has thousands of tiny files; every operation does many small reads/writes. EFS, NFS, networked dev-container volumes, and other high-latency storage amortize that poorly — a `git status` that takes 10ms locally can take seconds on EFS.
- **Real filesystem side effects** — every experimental commit is permanent until rolled back.
- **No isolation between parallel agents** — they fight over the working tree.
- **Opaque to the orchestrator** — you can't easily inspect what the agent ran.

MemoryGit solves these by running git purely in memory via [isomorphic-git](https://isomorphic-git.org/) on a per-instance [memfs](https://github.com/streamich/memfs) volume:

- **`exec(cmd: string)` — bash-like dispatcher.** Feed agents the same git CLI strings they'd run in a terminal. Pre-existing prompts, RAG examples, and tool definitions transfer directly.
- **No subprocess.** All ops resolve in-process. Overhead drops from ~3.6ms/call to ~0.03ms/call.
- **`.git/` stays off the slow disk.** Load the working tree from EFS/NFS once, do all git work in RAM, flush only the files you care about back. The thousands of small-file ops that kill networked storage never happen on disk.
- **Isolated per instance.** Spin up one MemoryGit per agent / task / branch attempt. Try, throw away, retry — no cleanup needed.
- **Operation log = audit trail.** Every method call (including via `exec`) is recorded with params, success/failure, and timestamps. Replay or summarize what the agent did.
- **Flush is explicit.** Memory state never touches disk until `flush()`. Agents can speculatively branch, commit, reset — and only persist the result you approve.

## Installation

```bash
npm install memory-git
# or
pnpm add memory-git
```

## Quickstart for agents

```typescript
import { MemoryGit } from 'memory-git';

const mg = new MemoryGit('agent-session-42');
mg.setAuthor('Agent Smith', 'agent@example.com');

await mg.loadFromDisk('./repo', { ignore: ['node_modules', 'dist'] });

// Hand `exec` straight to the agent — no parser, no shell escaping, no PTY.
await mg.exec('git checkout -b agent/fix-typo');
await mg.writeFile('src/util.ts', /* … */);
await mg.exec('git add src/util.ts');
await mg.exec('git commit -m "fix: typo in helper"');

// Inspect what the agent did before persisting
console.log(mg.exportOperationsLog());

// Persist only if you're happy with the result
await mg.flush();
```

## The `exec()` dispatcher

`exec(cmd)` accepts a bash-style git command string, strips a leading `git` if present, parses flags with `mri`, tokenizes with `shell-quote` (so `-m "messages with spaces"` work), and dispatches to the underlying TypeScript API.

```typescript
await mg.exec('status --porcelain');
await mg.exec('git log -n 5 --oneline');
await mg.exec('git commit --amend -m "reworded"');
await mg.exec('git diff HEAD~1 HEAD --name-only');
await mg.exec('git tag -a v1.0 -m "release"');
await mg.exec('git config user.name "Agent"');
```

### Supported subcommands

| Command | Notable flags |
|---|---|
| `init` | `-b/--initial-branch`, `--bare` |
| `add` | `<path...>`, `.`, `-A/--all`, `-u/--update` |
| `rm` | `<file>`, `--cached` |
| `mv` | `<from> <to>`, `-f` |
| `commit` | `-m <msg>`, `--amend`, `--allow-empty`, `-a/--all`, `--author=<n <e>>`, `--date=<iso>` |
| `status` | (default human-readable), `--porcelain`, `-s/--short`, `-b/--branch` |
| `log` | `-n <count>`, `--oneline`, `--author=<s>`, `--since=<iso>`, `--until=<iso>`, `<ref>` |
| `show` | `<ref>` |
| `diff` | `--cached/--staged`, `--name-only`, `--name-status`, `<from> <to>` |
| `branch` | (list), `<name>` (create), `-d/-D <name>`, `-m <old> <new>` |
| `checkout` | `<ref>`, `-b <new>`, `-f`, `-- <files...>` |
| `merge` | `<branch>`, `--no-ff`, `--ff-only`, `-m <msg>` |
| `tag` | `<name>`, `-a -m <msg>`, `-d <name>`, `-f`, `-l` |
| `reset` | `--soft`, `--mixed`, `--hard`, `<ref>`, `-- <files...>` |
| `clone` | `<url>`, `-b/--branch <ref>`, `--depth <n>`, `--single-branch`, `--no-checkout` |
| `fetch` | `[<remote>]`, `--prune`, `--tags`, `--depth <n>` |
| `pull` | `[<remote>] [<branch>]`, `--ff-only` |
| `push` | `[<remote>] [<ref>]`, `--force`, `--delete` |
| `remote` | `-v`, `add <name> <url>`, `remove <name>` |
| `config` | `<key> [<value>]` |
| `stash` | `push` (default), `pop`, `list` |
| `rev-parse` | `<ref>`, `--short`, `--abbrev-ref` |
| `rev-list` | `<ref>`, `--all`, `--reverse`, `-n/--max-count <n>` |
| `ls-files` | — |

Unsupported subcommands (`rebase`, `cherry-pick`, `bisect`, `reflog`, `submodule`, `worktree`, `blame`, `gc`) throw a clear error rather than silently misbehaving.

### Output format

`exec()` returns a string mimicking real git CLI output:

```
> git commit -m "msg"
[main 4a1b2c3] msg

> git status --porcelain
 M src/index.ts
?? new-file.txt

> git log --oneline
4a1b2c3 msg
0f1e2d3 init
```

If you need structured data instead, call the underlying methods directly: `await mg.commit('msg')` returns the SHA; `await mg.status()` returns `FileStatus[]`; etc.

## Programmatic API

The class-based API is fully typed and remains the preferred entry point when you need structured results.

### Setup

| Method | Description |
|--------|-------------|
| `new MemoryGit(name?)` | Creates instance with isolated volume |
| `setAuthor(name, email)` | Sets commit author |
| `config(key, value?)` | Get/set git config (special-cases `user.name`/`user.email` to sync with author) |
| `init(options?)` | Initializes empty repo. `{defaultBranch, bare}` |
| `loadFromDisk(path, options?)` | Loads existing repo. `{respectGitignore, nestedGitignore, ignore, incremental}` — by default skips files matching root + nested `.gitignore` files |
| `clone(url, options?)` | Clones remote. `{branch, depth, singleBranch, noCheckout}` |
| `clear()` | Resets memory state |
| `flush(targetPath?, options?)` | Syncs memory to disk. `{incremental, clean}` |

### Files

| Method | Description |
|--------|-------------|
| `writeFile(filepath, content)` | Writes file |
| `readFile(filepath)` | Reads file |
| `deleteFile(filepath)` | Deletes file |
| `fileExists(filepath)` | Checks existence |
| `listFiles(dir?, includeGit?)` | Lists files in working tree |
| `rename(old, new, options?)` | `git mv`. `{force}` |

### Staging and commits

| Method | Description |
|--------|-------------|
| `add(filepath, options?)` | Stage. `filepath`: string \| string[] \| `'.'`. `{all, update}` |
| `remove(filepath, options?)` | `git rm`. `{cached}` keeps the working file |
| `commit(message, options?)` | Returns SHA. `{amend, allowEmpty, all, author, date}` |
| `status()` | Returns `FileStatus[]` |
| `statusText(options?)` | Porcelain/short/branch text format |
| `diff(options?)` | `{cached, fromRef, toRef, paths}` |
| `diffText(options?)` | `{nameOnly, nameStatus}` |

### History

| Method | Description |
|--------|-------------|
| `log(options?)` | `{depth, ref, author, since, until}`. Returns `CommitInfo[]` |
| `logText(options?)` | `{oneline}` |
| `show(ref?)` | Commit metadata + changed files |
| `resolveRef(ref?, options?)` | `git rev-parse`. `{short, abbrevRef}`. Accepts short OIDs |
| `revList(options?)` | `{all, reverse, maxCount, ref}` |
| `readFileAtRef(filepath, ref?, options?)` | `{encoding: 'utf8' \| 'buffer'}` |
| `listTrackedFiles(ref?)` | `git ls-tree -r` |
| `getChangedFiles(fromRef, toRef?, options?)` | Diff two refs. `{filter}` |
| `reset(ref?, options?)` | `{mode: 'soft' \| 'mixed' \| 'hard', paths}` |
| `resetFile(filepath)` | Resets single file to HEAD |

### Branches

| Method | Description |
|--------|-------------|
| `createBranch(name)` | Create |
| `deleteBranch(name, options?)` | `{force}` — without force, refuses to delete unmerged branches |
| `renameBranch(old, new)` | `git branch -m` |
| `checkout(ref, options?)` | `{createBranch, force, files}` |
| `listBranches()` | Returns `BranchInfo[]` |
| `branchText()` | `git branch` text format (current branch prefixed with `*`) |
| `currentBranch()` | Returns current branch name |
| `merge(branch, options?)` | `{noFastForward, fastForwardOnly, message}` |

### Tags

| Method | Description |
|--------|-------------|
| `createTag(name, refOrOptions?, options?)` | Lightweight or annotated. `{ref, annotated, message, force}` |
| `listTags()` | Tag names |
| `deleteTag(name)` | `git tag -d` |
| `describeExact(ref?)` | `git describe --exact-match --tags` |
| `showTagRefs()` | Resolves annotated tags to commit OIDs |

### Remotes

| Method | Description |
|--------|-------------|
| `addRemote(name, url)` | Add |
| `deleteRemote(name)` | Remove |
| `listRemotes()` | `RemoteInfo[]` |
| `fetch(options?)` | `{remote, prune, tags, depth, singleBranch, ref}` |
| `pull(options?, branch?)` | `{remote, branch, fastForward, fastForwardOnly}` |
| `push(options?, ref?)` | `{remote, ref, remoteRef, force, delete}` |

### Stash

| Method | Description |
|--------|-------------|
| `stash()` | Saves workdir changes, restores to HEAD |
| `stashPop()` | Restores most recent stash |
| `stashList()` | Stash count |

### Observability — the audit trail

Every method records an entry in the operation log. This is what makes MemoryGit useful as an agent harness: you always know exactly what the agent did.

| Method | Description |
|--------|-------------|
| `getOperationsLog()` | All recorded operations with timestamps, params, results |
| `getOperationsStats()` | Aggregated counts by operation, success/failure |
| `exportOperationsLog()` | JSON string suitable for storing or feeding back to a model |
| `clearOperationsLog()` | Reset the log |
| `onOperation(cb)` | Subscribe to log entries as they're recorded; returns an unsubscribe function |
| `getMemoryUsage()` | Estimated bytes / file count |
| `getRepoInfo()` | Repo summary |

```typescript
const unsub = mg.onOperation(op => {
    tracing.record(op.operation, { ok: op.success, ms: 0, err: op.error });
});
// ...later
unsub();
```

Listener errors are swallowed (set `MEMORY_GIT_DEBUG=1` to log them); they will never break a git op.

### Streaming output

Long results (a 1000-commit log, every tracked path) don't have to be buffered.
`execStream()` yields one logical line at a time, lets you break early, and
respects an `AbortSignal`.

```typescript
for await (const line of mg.execStream('git log --oneline')) {
    if (shouldStop()) break;
    process.stdout.write(line + '\n');
}
```

`log`, `ls-files`, and `rev-list` yield item-by-item; other subcommands compute
the full output then yield line-by-line.

### Cancellation

`exec()`, `execStream()`, `clone()`, `fetch()`, `pull()`, and `push()` accept a
standard `AbortSignal`. On abort, the awaited promise rejects with a Web-standard
`AbortError` (`DOMException`).

```typescript
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);
try {
    await mg.clone(url, { signal: ctrl.signal });
} catch (e) {
    if ((e as DOMException).name === 'AbortError') {
        // request was cancelled; mutation, if any, is left as-is
    }
}
```

Any state mutated before abort stays mutated — rollback (e.g. `mg.clear()` and
retry) is the caller's responsibility.

### Integration with just-bash

The `memory-git/adapters/just-bash` sub-export wraps a `MemoryGit` instance in
[just-bash](https://www.npmjs.com/package/just-bash)'s `IFileSystem` interface,
so a single in-memory Volume can serve both git ops and shell ops. Install
`just-bash` only if you use this sub-export.

```typescript
import { MemoryGit } from 'memory-git';
import { toJustBashFs } from 'memory-git/adapters/just-bash';
import { Bash } from 'just-bash';

const mg = new MemoryGit();
await mg.init();

const bash = new Bash({ fs: toJustBashFs(mg) });
await bash.run('echo "hello" > /repo/greet.txt');

await mg.add('greet.txt');
await mg.commit('add greeting');
```

Pass `onWrite` to be notified after every mutating call — useful for tracking
dirty paths for write-behind flushing:

```typescript
import { MemfsBackedFs } from 'memory-git/adapters/just-bash';

const dirty = new Set<string>();
const fs = new MemfsBackedFs(mg.volume, {
    onWrite: (path, op) => { dirty.add(path); }
});
```

If you need the raw Node-fs-compatible interface for other libraries, use
`mg.volume` directly — it returns the same in-memory `IFs` object.

## Patterns for agent workflows

### Speculative work, conditional persist

```typescript
const mg = new MemoryGit();
await mg.loadFromDisk('./repo');

await mg.exec('git checkout -b speculative');
await agent.makeChanges(mg);          // agent reads/writes via mg
await mg.exec('git add .');
await mg.exec('git commit -m "agent attempt"');

const ok = await verify(mg);          // run tests, lint, whatever
if (ok) await mg.flush();             // only NOW does it touch real disk
```

### Parallel attempts in isolation

```typescript
const attempts = await Promise.all(
    ['claude', 'gpt', 'haiku'].map(async name => {
        const mg = new MemoryGit(name);
        await mg.loadFromDisk('./repo');
        await agent[name].run(mg);
        return { name, log: mg.getOperationsLog(), passed: await verify(mg) };
    })
);
// Pick the winner, flush only that one.
```

### Bypass slow storage (EFS / NFS / network mounts)

```typescript
// Repo lives on EFS. Cloning or running git there would be glacial.
const mg = new MemoryGit();
await mg.loadFromDisk('/mnt/efs/repo', { ignore: ['node_modules'] });

// All git ops happen in RAM — no per-object round-trip to EFS
await mg.exec('git checkout -b release/2026.05');
await mg.exec('git log --oneline -n 50');
await mg.exec('git diff main --name-only');

// Flush only the working tree changes back; .git/ never touches EFS again
await mg.flush('/mnt/efs/repo');
```

A typical `.git/` on a real project has 5k-50k tiny object files. On EFS that's 5k-50k × ~10ms = unusable. In memory it's a `for` loop.

### Replay / summarize the agent's session

```typescript
const summary = mg.getOperationsStats();
// { total: 47, successful: 45, failed: 2, byOperation: { commit: { ... } } }

const fullLog = mg.exportOperationsLog();  // JSON
```

## Loading and persisting

```typescript
const mg = new MemoryGit();

// By default, loadFromDisk respects every .gitignore in the tree (root + nested).
// The repo's own .git/ is always loaded regardless of any pattern.
await mg.loadFromDisk('./existing-repo');

// You can still add explicit patterns on top, or opt out entirely:
await mg.loadFromDisk('./existing-repo', {
    ignore: ['*.pem', 'secrets/'],   // added to whatever .gitignore says
    nestedGitignore: false,          // only honor the root .gitignore
    // respectGitignore: false,      // disable gitignore entirely
});

// ... do work ...

await mg.flush();                       // back to original path
await mg.flush('./output-dir');         // or somewhere else
```

### Incremental sync

Both `loadFromDisk` and `flush` accept `incremental: true`. With it on, MemoryGit keeps a per-file fingerprint of the last sync state and only reads/writes files that changed.

```typescript
const mg = new MemoryGit();

// First call: full read, plus build the fingerprint snapshot.
await mg.loadFromDisk('./repo', { incremental: true });

// Later — pick up only the files that changed on disk (size/mtime pre-filter):
await mg.loadFromDisk('./repo', { incremental: true });

// ...mutate a few files in memory...
await mg.writeFile('src/a.ts', '// edited');

// Only files whose content hash differs from the snapshot are written.
// Use clean:true to also delete files removed from memory.
await mg.flush('./repo', { incremental: true, clean: true });
```

When incremental flush is on, the snapshot is treated as authoritative for the destination — we don't stat disk on every file. External writes between flushes are invisible until you `loadFromDisk({incremental:true})` again. This is the trade-off that makes it cheap on EFS/NFS, where one stat per file dominates the cost.

## TypeScript

All option and result types are exported:

```typescript
import {
    MemoryGit,
    // Options
    InitOptions, AddOptions, CommitOptions, RemoveOptions,
    DeleteBranchOptions, CheckoutOptions, MergeOptions,
    CreateTagOptions, ResetOptions, RenameOptions,
    CloneOptions, FetchOptions, PullOptions, PushOptions,
    LogOptions, ResolveRefOptions, DiffOptions,
    // Results
    CommitInfo, FileStatus, BranchInfo, RemoteInfo,
    TagRef, ChangedFile, DiffEntry, MergeResult,
    ShowResult, RevListOptions, ResetMode,
    MemoryUsage, RepoInfo, Author, OperationLogEntry, OperationStats
} from 'memory-git';
```

## Migration from v1 to v2

**Breaking change in v2:** each instance now has its own isolated filesystem volume. In v1, all instances shared a global memfs volume, causing interference.

```typescript
// v2 — instances are fully isolated
const g1 = new MemoryGit('a');
const g2 = new MemoryGit('b'); // independent volume, no interference
```

## Performance

Run `pnpm run benchmark` to reproduce.

| Workload | Git CLI (`execSync`) | MemoryGit | Result |
|---|---|---|---|
| Process spawn overhead | ~12-13ms / call | none | — |
| `exec()` parsing overhead (tokenize + flag-parse) | — | ~3-6µs / call | negligible |
| 400 small commands (status / log / rev-parse / branch) | 5581ms | 43ms | **129× faster** |
| 100 sequential commits | 3499ms | 176ms | **19.9× faster** |
| 200 status / write / add / commit / log cycles | 15723ms | 1050ms | **15.0× faster** |
| 50× repeated `git log` | 703ms | 37ms | **18.8× faster** |
| Init + 50 files + commit + branch + merge | 958ms | 102ms | **9.4× faster** |

Three takeaways:

1. **`exec()` parsing is free.** It adds 3-6µs to a call that previously cost ~12ms via subprocess. The string-API ergonomics carry no real cost.
2. **The agent-loop pattern is the killer use case.** Many small read-style calls amortize JS-level overhead and skip the per-call spawn tax — **>100× faster end-to-end**.
3. **Multi-file commits are also faster.** A dirty-set tracker (writeFile marks files as needing re-stage; `add('.')` only touches those) means write-heavy workloads beat the C binary on local SSD too.

**The gap widens dramatically on slow filesystems.** Git's `.git/objects/` is small-file-heavy by design (one file per blob, tree, and commit), which is the worst-case access pattern for EFS, NFS, and overlay/networked dev-container volumes. A `git log` over a large history that runs in 50ms on local SSD can take tens of seconds on EFS — every object is a round-trip. MemoryGit keeps all that in RAM and only flushes the actual working-tree files back when you ask it to.

<details>
<summary>Benchmark machine</summary>

- Apple M4 Pro · 12 cores · 24 GB RAM
- macOS 26.3.1
- APFS on internal NVMe SSD
- Node.js v26.1.0
- memory-git v3.1.1, isomorphic-git v1.37, memfs v4.57

Numbers vary per machine; the ratios are what matter, and they grow on slower disks.

</details>

## Dependencies

- [isomorphic-git](https://isomorphic-git.org/) — pure-JS Git implementation
- [memfs](https://github.com/streamich/memfs) — in-memory filesystem
- [shell-quote](https://github.com/ljharb/shell-quote) — bash-style tokenization for `exec()`
- [mri](https://github.com/lukeed/mri) — minimal CLI flag parser for `exec()`
- [ignore](https://github.com/kaelzhang/node-ignore) — `.gitignore`-style pattern matching for `loadFromDisk`

## License

MIT
