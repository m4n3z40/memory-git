const { MemoryGit } = require('./index');

/**
 * MemoryGit usage example
 * Demonstrates in-memory git operations with final flush to disk
 */
async function main() {
    console.log('='.repeat(60));
    console.log('MemoryGit - In-Memory Git Demonstration');
    console.log('='.repeat(60));
    
    const memGit = new MemoryGit('demo-fs');
    
    // Set the author for commits
    memGit.setAuthor('Developer', 'dev@example.com');
    
    try {
        // 1. Initialize a new repository in memory
        console.log('\n📁 Initializing repository in memory...');
        await memGit.init();
        
        // 2. Create some files
        console.log('\n✏️  Creating files...');
        
        await memGit.writeFile('README.md', `# My Project

This is a MemoryGit demonstration project.

## Description

All operations are done in memory for maximum performance.
`);
        
        await memGit.writeFile('src/index.js', `// Application entry point
console.log('Hello, MemoryGit!');

module.exports = { version: '1.0.0' };
`);
        
        await memGit.writeFile('src/utils/helper.js', `// Utility functions
function formatDate(date) {
    return date.toISOString();
}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

module.exports = { formatDate, generateId };
`);
        
        await memGit.writeFile('package.json', JSON.stringify({
            name: 'demo-project',
            version: '1.0.0',
            main: 'src/index.js'
        }, null, 2));
        
        // 3. Check status
        console.log('\n📊 Repository status:');
        const status1 = await memGit.status();
        status1.forEach(f => console.log(`   ${f.status}: ${f.filepath}`));
        
        // 4. Add and commit
        console.log('\n📦 Adding files to staging...');
        await memGit.add('.');
        
        console.log('\n✅ Creating initial commit...');
        const commit1 = await memGit.commit('feat: initial commit with base project structure');
        console.log(`   Commit created: ${commit1.slice(0, 7)}`);
        
        // 5. Create a new branch
        console.log('\n🌿 Creating branch "feature/new-feature"...');
        await memGit.createBranch('feature/new-feature');
        await memGit.checkout('feature/new-feature');
        
        const currentBranch = await memGit.currentBranch();
        console.log(`   Current branch: ${currentBranch}`);
        
        // 6. Make changes in the new branch
        console.log('\n✏️  Adding new feature...');
        await memGit.writeFile('src/feature.js', `// New feature
class Feature {
    constructor(name) {
        this.name = name;
    }
    
    execute() {
        console.log(\`Executing: \${this.name}\`);
    }
}

module.exports = { Feature };
`);
        
        // Update README
        const readmeContent = await memGit.readFile('README.md');
        await memGit.writeFile('README.md', readmeContent + `
## New Feature

Added Feature class for demonstration.
`);
        
        await memGit.add('.');
        const commit2 = await memGit.commit('feat: add Feature class');
        console.log(`   Commit created: ${commit2.slice(0, 7)}`);
        
        // 7. Go back to main and merge
        console.log('\n🔀 Going back to main and merging...');
        await memGit.checkout('main');
        const mergeResult = await memGit.merge('feature/new-feature');
        console.log(`   Merge completed! Result: ${mergeResult.oid ? mergeResult.oid.slice(0, 7) : 'fast-forward'}`);
        
        // 8. List branches
        console.log('\n🌲 Existing branches:');
        const branches = await memGit.listBranches();
        branches.forEach(b => console.log(`   ${b.current ? '* ' : '  '}${b.name}`));
        
        // 9. Show commit log
        console.log('\n📜 Commit history:');
        const logs = await memGit.log(5);
        logs.forEach(log => {
            console.log(`   ${log.sha.slice(0, 7)} - ${log.message.split('\n')[0]} (${log.author})`);
        });
        
        // 10. List files
        console.log('\n📂 Files in repository:');
        const files = await memGit.listFiles();
        files.forEach(f => console.log(`   ${f}`));
        
        // 11. Show operation statistics
        console.log('\n📈 In-memory operation statistics:');
        const stats = memGit.getOperationsStats();
        console.log(`   Total operations: ${stats.total}`);
        console.log(`   Successful: ${stats.successful}`);
        console.log(`   Failed: ${stats.failed}`);
        console.log('\n   By operation type:');
        Object.entries(stats.byOperation).forEach(([op, data]) => {
            console.log(`     ${op}: ${data.total} (${data.successful} ok, ${data.failed} failed)`);
        });
        
        // 12. Show memory usage
        console.log('\n💾 Memory usage:');
        const memUsage = memGit.getMemoryUsage();
        console.log(`   Files in memory: ${memUsage.files}`);
        console.log(`   Estimated size: ${memUsage.estimatedSizeMB} MB`);
        console.log(`   Logged operations: ${memUsage.operationsLogged}`);
        
        // 13. Flush to disk
        console.log('\n💾 Saving repository to disk...');
        const outputPath = './output-repo';
        const filesFlushed = await memGit.flush(outputPath);
        console.log(`   Repository saved to: ${outputPath}`);
        console.log(`   Files written: ${filesFlushed}`);
        
        // 14. Show complete operation log (last 10)
        console.log('\n📋 Complete operation log (last 10):');
        const operationsLog = memGit.getOperationsLog();
        operationsLog.slice(-10).forEach(op => {
            const status = op.success ? '✓' : '✗';
            console.log(`   [${op.timestamp}] ${status} ${op.operation}`);
        });
        
        console.log('\n' + '='.repeat(60));
        console.log('Demonstration completed!');
        console.log('Zero IO operations during git operations.');
        console.log('All disk writes were done only in flush().');
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        console.log('\n📋 Operation log up to error:');
        memGit.getOperationsLog().forEach(op => {
            console.log(`   [${op.timestamp}] ${op.success ? '✓' : '✗'} ${op.operation}`);
            if (op.error) console.log(`      Error: ${op.error}`);
        });
    }
}

// Example of loading existing repository
async function loadExistingRepo() {
    console.log('\n' + '='.repeat(60));
    console.log('Example: Loading existing repository');
    console.log('='.repeat(60));
    
    const memGit = new MemoryGit('load-demo');
    memGit.setAuthor('Developer', 'dev@example.com');
    
    try {
        // Load an existing repository from disk
        console.log('\n📂 Loading repository from disk...');
        const filesLoaded = await memGit.loadFromDisk('./output-repo');
        console.log(`   Files loaded: ${filesLoaded}`);
        
        // Make modifications in memory
        console.log('\n✏️  Modifying files in memory...');
        await memGit.writeFile('CHANGELOG.md', `# Changelog

## [1.1.0] - ${new Date().toISOString().split('T')[0]}
- Added changelog
- General improvements
`);
        
        await memGit.add('CHANGELOG.md');
        await memGit.commit('docs: add CHANGELOG.md');
        
        // Show status
        const logs = await memGit.log(3);
        console.log('\n📜 Latest commits:');
        logs.forEach(log => {
            console.log(`   ${log.sha.slice(0, 7)} - ${log.message.split('\n')[0]}`);
        });
        
        // Show repo info
        console.log('\n📊 Repository information:');
        const info = await memGit.getRepoInfo();
        console.log(`   Current branch: ${info.currentBranch}`);
        console.log(`   Total commits: ${info.commits}`);
        console.log(`   Total files: ${info.fileCount}`);
        
        // Save back
        console.log('\n💾 Saving changes...');
        await memGit.flush();
        
        console.log('\n✅ Changes saved successfully!');
        
        // Export operation log (async)
        console.log('\n📄 Exporting operation log to file...');
        const logJson = memGit.exportOperationsLog();
        await require('fs').promises.writeFile('./output-repo/operations-log.json', logJson);
        console.log('   Log exported to: ./output-repo/operations-log.json');
        
    } catch (error) {
        console.error('Error:', error.message);
        console.error(error.stack);
    }
}

// Stash demonstration
async function stashDemo() {
    console.log('\n' + '='.repeat(60));
    console.log('Example: Stash Demonstration');
    console.log('='.repeat(60));
    
    const memGit = new MemoryGit('stash-demo');
    memGit.setAuthor('Developer', 'dev@example.com');
    
    try {
        await memGit.init();
        
        // Create initial file
        await memGit.writeFile('main.js', 'console.log("v1");');
        await memGit.add('.');
        await memGit.commit('Initial commit');
        
        // Make modifications
        console.log('\n✏️  Modifying file...');
        await memGit.writeFile('main.js', 'console.log("v2 - work in progress");');
        
        const contentBefore = await memGit.readFile('main.js');
        console.log(`   Current content: ${contentBefore.trim()}`);
        
        // Save to stash
        console.log('\n📦 Saving to stash...');
        const stashedCount = await memGit.stash();
        console.log(`   ${stashedCount} file(s) saved to stash`);
        
        const contentAfterStash = await memGit.readFile('main.js');
        console.log(`   Content after stash: ${contentAfterStash.trim()}`);
        
        // Restore from stash
        console.log('\n📤 Restoring from stash...');
        await memGit.stashPop();
        
        const contentAfterPop = await memGit.readFile('main.js');
        console.log(`   Restored content: ${contentAfterPop.trim()}`);
        
        console.log('\n✅ Stash working correctly!');
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Run demonstrations
main()
    .then(() => loadExistingRepo())
    .then(() => stashDemo())
    .catch(console.error);
