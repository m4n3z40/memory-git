const path = require('path');
const fs = require('fs').promises;
const { MemoryGit } = require('..');

const OUTPUT_REPO = path.join(__dirname, 'output-repo');

const hr = (label = '') => {
    const line = '='.repeat(70);
    console.log('\n' + line);
    if (label) console.log(`  ${label}`);
    if (label) console.log(line);
};

/**
 * Demo 1: Agent-style workflow using exec()
 *
 * This is what the bash-like exec() dispatcher is for. An AI agent (or any
 * script that already speaks git CLI) can issue the same command strings it
 * would type in a terminal — no parser, no subprocess, no disk side effects
 * until flush().
 */
async function agentWorkflow() {
    hr('Demo 1: Agent workflow via exec()');

    const mg = new MemoryGit('agent-session');
    await mg.exec('git init -b main');
    await mg.exec('git config user.name "Agent Smith"');
    await mg.exec('git config user.email "agent@example.com"');

    // The agent writes some files (the writeFile/readFile API exists because
    // the in-memory FS isn't reachable through bash redirection)
    await mg.writeFile('README.md', '# Agent Project\n\nDraft.\n');
    await mg.writeFile('src/index.js', 'console.log("v1");\n');
    await mg.writeFile('package.json', JSON.stringify({ name: 'agent-project', version: '0.0.1' }, null, 2));

    // Everything else looks exactly like a bash session
    console.log('\n$ git status --short');
    console.log(await mg.exec('git status --short'));

    console.log('\n$ git add .');
    await mg.exec('git add .');

    console.log('\n$ git commit -m "feat: initial scaffold"');
    console.log(await mg.exec('git commit -m "feat: initial scaffold"'));

    // Branch, change, commit
    console.log('\n$ git checkout -b feat/logger');
    console.log(await mg.exec('git checkout -b feat/logger'));

    await mg.writeFile('src/index.js', 'const log = (m) => console.log("[LOG]", m);\nlog("v2");\n');

    console.log('\n$ git add . && git commit -m "feat: add logger"');
    await mg.exec('git add .');
    console.log(await mg.exec('git commit -m "feat: add logger"'));

    // Merge back
    console.log('\n$ git checkout main');
    await mg.exec('git checkout main');
    console.log('\n$ git merge feat/logger');
    console.log(await mg.exec('git merge feat/logger'));

    // Inspect
    console.log('\n$ git log --oneline');
    console.log(await mg.exec('git log --oneline'));

    console.log('\n$ git branch');
    console.log(await mg.exec('git branch'));

    // Audit trail — every method call (including via exec) is recorded
    const stats = mg.getOperationsStats();
    console.log(`\n📋 Operations recorded: ${stats.total} (${stats.successful} ok, ${stats.failed} failed)`);
    console.log('   Top operations:');
    Object.entries(stats.byOperation)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 5)
        .forEach(([op, d]) => console.log(`     ${op}: ${d.total}`));
}

/**
 * Demo 2: Programmatic API for when you need structured data
 *
 * exec() returns formatted strings (like the real CLI). When you need typed
 * results — SHA strings, commit objects, file lists — call the typed methods
 * directly. They share the same in-memory state.
 */
async function programmaticWorkflow() {
    hr('Demo 2: Programmatic API (typed returns)');

    const mg = new MemoryGit('typed-demo');
    mg.setAuthor('Developer', 'dev@example.com');
    await mg.init();

    await mg.writeFile('a.txt', 'first');
    await mg.add('a.txt');
    const sha1 = await mg.commit('first');

    await mg.writeFile('a.txt', 'second');
    await mg.writeFile('b.txt', 'new');
    await mg.add('.');
    const sha2 = await mg.commit('second');

    console.log(`\n  sha1 = ${sha1}`);
    console.log(`  sha2 = ${sha2}`);

    // show() returns structured commit + changed files
    const show = await mg.show(sha2);
    console.log(`\n  show(${sha2.slice(0, 7)}):`);
    console.log(`    message: ${show.commit.message.trim()}`);
    console.log(`    changes: ${show.changes.map(c => `${c.status} ${c.filepath}`).join(', ')}`);

    // diff between two refs
    const diff = await mg.diff({ fromRef: sha1, toRef: sha2 });
    console.log(`\n  diff(${sha1.slice(0, 7)} → ${sha2.slice(0, 7)}):`);
    diff.forEach(d => console.log(`    ${d.status} ${d.filepath}`));

    // amend the last commit (note: the new sha differs)
    await mg.writeFile('a.txt', 'second (fixed)');
    await mg.add('a.txt');
    const amended = await mg.commit('second', { amend: true });
    console.log(`\n  amended: ${sha2.slice(0, 7)} → ${amended.slice(0, 7)}`);

    // rev-list with options
    const all = await mg.revList({ all: true, reverse: true });
    console.log(`\n  rev-list (reverse): ${all.map(s => s.slice(0, 7)).join(', ')}`);
}

/**
 * Demo 3: Slow-storage pattern (EFS / NFS / network mounts)
 *
 * The pain point: .git/objects is thousands of tiny files. Every git op on
 * EFS becomes a torrent of high-latency round-trips. MemoryGit reads the
 * working tree once, does all git work in RAM, and only writes back the
 * files you care about.
 */
async function slowFsPattern() {
    hr('Demo 3: Load → work in memory → flush (slow-storage pattern)');

    // Simulate a repo that lives on slow storage by first creating one,
    // then loading it (which is the one slow operation we accept).
    await fs.rm(OUTPUT_REPO, { recursive: true, force: true }).catch(() => {});
    const seed = new MemoryGit('seed');
    seed.setAuthor('Seed', 'seed@example.com');
    await seed.init();
    for (let i = 0; i < 10; i++) {
        await seed.writeFile(`pkg/${i}.txt`, `payload ${i}\n`.repeat(50));
    }
    await seed.add('.');
    await seed.commit('seed');
    await seed.flush(OUTPUT_REPO);

    // The real workload: an agent loads, does many ops, flushes once
    console.log('\n📂 Loading repository...');
    const mg = new MemoryGit('slow-fs');
    mg.setAuthor('Worker', 'worker@example.com');
    const loaded = await mg.loadFromDisk(OUTPUT_REPO);
    console.log(`   Loaded ${loaded} files into memory`);

    // Tons of operations — none of these touch the slow disk
    console.log('\n⚡ Doing 50 in-memory operations (no disk IO):');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) {
        await mg.exec('git status --porcelain');
        await mg.exec('git log --oneline -n 1');
    }
    const elapsed = Number(process.hrtime.bigint() - t0) / 1_000_000;
    console.log(`   100 status+log calls completed in ${elapsed.toFixed(1)}ms`);
    console.log(`   On EFS this would have been ~${(100 * 200).toFixed(0)}ms+ minimum`);

    // Make a change and flush — only writes the changed working-tree files
    await mg.writeFile('CHANGELOG.md', '# Changelog\n\n- new entry\n');
    await mg.add('CHANGELOG.md');
    await mg.exec('git commit -m "docs: changelog"');

    console.log('\n💾 Flushing back to disk...');
    const flushed = await mg.flush();
    console.log(`   ${flushed} files written`);
}

/**
 * Demo 4: Stash via exec()
 */
async function stashDemo() {
    hr('Demo 4: Stash');

    const mg = new MemoryGit('stash-demo');
    mg.setAuthor('Developer', 'dev@example.com');
    await mg.init();

    await mg.writeFile('main.js', 'console.log("v1");');
    await mg.add('.');
    await mg.commit('init');

    await mg.writeFile('main.js', 'console.log("v2 wip");');
    console.log(`\n  workdir before stash: ${(await mg.readFile('main.js')).trim()}`);

    console.log(`\n$ git stash`);
    console.log('  ' + await mg.exec('git stash'));
    console.log(`  workdir after stash: ${(await mg.readFile('main.js')).trim()}`);

    console.log(`\n$ git stash list`);
    console.log('  ' + await mg.exec('git stash list'));

    console.log(`\n$ git stash pop`);
    console.log('  ' + await mg.exec('git stash pop'));
    console.log(`  workdir after pop: ${(await mg.readFile('main.js')).trim()}`);
}

(async () => {
    try {
        await agentWorkflow();
        await programmaticWorkflow();
        await slowFsPattern();
        await stashDemo();

        hr('Done');
        console.log('All git operations ran in memory. Disk was touched only in flush().');
        console.log('Inspect ' + OUTPUT_REPO + ' for the flushed output.');
    } catch (err) {
        console.error('\n❌ Error:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
