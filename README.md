# MemoryGit

In-memory Git implementation that minimizes IO operations. The project is loaded into memory, all git operations are executed in memory, and only at the end are changes synchronized (flushed) to disk.

## Features

- **Zero IO during git operations**: All operations are done in memory
- **Non-blocking**: All real disk operations use `fs.promises` (async) to not block the event loop
- **Operation logging**: Records all operations performed with timestamps
- **Controlled flush**: Syncs to disk only when you decide
- **Complete API**: Supports main git operations (init, add, commit, branch, merge, etc.)
- **In-memory stash**: Stash support without touching disk
- **Usage metrics**: Operation statistics and memory usage
- **Parallel copying**: Files are copied in parallel during `loadFromDisk` and `flush` for better performance

## Installation

```bash
npm install memory-git
# or
pnpm add memory-git
# or
yarn add memory-git
```

## Basic Usage

```javascript
const { MemoryGit } = require('memory-git');

async function example() {
    const memGit = new MemoryGit('my-project');
    
    // Set the author
    memGit.setAuthor('Your Name', 'email@example.com');
    
    // Initialize a new repository in memory
    await memGit.init();
    
    // Create files (in memory)
    await memGit.writeFile('README.md', '# My Project');
    await memGit.writeFile('src/index.js', 'console.log("Hello");');
    
    // Git operations (all in memory)
    await memGit.add('.');
    await memGit.commit('Initial commit');
    
    // Create branch and make changes
    await memGit.createBranch('feature/new');
    await memGit.checkout('feature/new');
    
    // More changes...
    await memGit.writeFile('src/feature.js', 'export class Feature {}');
    await memGit.add('.');
    await memGit.commit('Add feature');
    
    // Merge
    await memGit.checkout('main');
    await memGit.merge('feature/new');
    
    // ONLY NOW save to disk
    await memGit.flush('./output-directory');
}
```

## Loading Existing Repository

```javascript
const memGit = new MemoryGit('loading');
memGit.setAuthor('Name', 'email@example.com');

// Load from disk to memory
await memGit.loadFromDisk('./my-existing-repo', {
    ignore: ['node_modules', '.pnpm-store', 'dist']
});

// Make changes in memory
await memGit.writeFile('CHANGELOG.md', '# Changelog\n\n- New version');
await memGit.add('.');
await memGit.commit('docs: add changelog');

// Save back to disk
await memGit.flush();
```

## API

### Initialization

| Method | Description |
|--------|-------------|
| `new MemoryGit(name)` | Creates new instance |
| `setAuthor(name, email)` | Sets author for commits |
| `init()` | Initializes repository in memory |
| `loadFromDisk(path, options)` | Loads repository from disk |
| `clone(url, options)` | Clones remote repository |
| `clear()` | Clears memory and reinitializes |

### File Operations

| Method | Description |
|--------|-------------|
| `writeFile(filepath, content)` | Writes file in memory |
| `readFile(filepath)` | Reads file from memory |
| `deleteFile(filepath)` | Removes file from memory |
| `fileExists(filepath)` | Checks if file exists |
| `listFiles(dir)` | Lists files in directory |

### Git Operations

| Method | Description |
|--------|-------------|
| `add(filepath)` | Adds to staging |
| `remove(filepath)` | Removes from staging and working tree |
| `commit(message)` | Creates commit |
| `status()` | Gets status |
| `log(depth)` | Lists commits |
| `diff()` | Shows changes |

### Branches

| Method | Description |
|--------|-------------|
| `createBranch(name)` | Creates branch |
| `deleteBranch(name)` | Deletes branch |
| `checkout(name)` | Switches to branch |
| `listBranches()` | Lists branches |
| `currentBranch()` | Gets current branch |
| `merge(branch)` | Performs merge |

### Remotes

| Method | Description |
|--------|-------------|
| `addRemote(name, url)` | Adds remote |
| `deleteRemote(name)` | Removes remote |
| `listRemotes()` | Lists remotes |
| `fetch(remote)` | Performs fetch |
| `pull(remote, branch)` | Performs pull |

### Stash

| Method | Description |
|--------|-------------|
| `stash()` | Saves changes to stash |
| `stashPop()` | Restores from stash |
| `stashList()` | Counts available stashes |

### Synchronization

| Method | Description |
|--------|-------------|
| `flush(targetPath)` | Saves everything to disk |

### Logs and Metrics

| Method | Description |
|--------|-------------|
| `getOperationsLog()` | Returns operation log |
| `clearOperationsLog()` | Clears log |
| `getOperationsStats()` | Operation statistics |
| `exportOperationsLog()` | Exports log as JSON |
| `getMemoryUsage()` | Estimated memory usage |
| `getRepoInfo()` | Repository information |

## Operation Logging

All operations are automatically recorded:

```javascript
const ops = memGit.getOperationsLog();
// [
//   {
//     timestamp: '2024-01-15T10:30:00.000Z',
//     operation: 'commit',
//     params: { message: 'feat: add feature' },
//     success: true,
//     result: { sha: 'abc123...' },
//     error: null
//   },
//   ...
// ]

// Statistics
const stats = memGit.getOperationsStats();
// {
//   total: 25,
//   successful: 24,
//   failed: 1,
//   byOperation: {
//     commit: { total: 5, successful: 5, failed: 0 },
//     ...
//   }
// }

// Export to file
const json = memGit.exportOperationsLog();
fs.writeFileSync('operations.json', json);
```

## Complete Example

Run the included example:

```bash
pnpm run example
```

## Benchmark: Git CLI vs MemoryGit

Run the benchmark:

```bash
pnpm run benchmark
```

### Summary Results

| Metric | Git CLI | MemoryGit | Difference |
|--------|---------|-----------|------------|
| Overhead per call | 3.63ms | 0.03ms | **~100x faster** |
| Log read (50x) | 232ms | 161ms | **1.4x faster** |
| Init | 15ms | 2ms | **7x faster** |
| Create branch | 3ms | 0.5ms | **6x faster** |
| Add (50 files) | 24ms | 53ms | 2.2x slower |
| Commit | 8ms | 4ms | **2x faster** |

### Analysis

- **Git CLI** is faster in heavy individual operations (add, checkout) because it's written in highly optimized C
- **MemoryGit** eliminates process spawn overhead (~3.6ms per call) and disk IO
- For **repeated reads** (status, log, branches), MemoryGit is significantly faster
- The final **flush** adds ~60ms to sync with disk

### When to use each

| Scenario | Recommendation |
|----------|----------------|
| Large repositories (> 500MB) | Git CLI |
| Automated tests | MemoryGit |
| Programmatic repo generation | MemoryGit |
| Single operations | Git CLI |
| Many reads (status, log) | MemoryGit |
| Low latency applications | MemoryGit |

## Dependencies

- [isomorphic-git](https://isomorphic-git.org/) - Pure JavaScript Git implementation
- [memfs](https://github.com/streamich/memfs) - In-memory filesystem

## TypeScript

The package includes complete TypeScript definitions:

```typescript
import { MemoryGit, CommitInfo, FileStatus } from 'memory-git';

const memGit = new MemoryGit('my-project');
```

## License

MIT
