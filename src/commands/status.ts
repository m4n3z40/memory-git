import git from 'isomorphic-git';
import mri from 'mri';
import type { Command } from './types.js';

const status: Command = {
    names: ['status'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { s: 'short', b: 'branch' },
            boolean: ['short', 'porcelain', 'branch'],
        });
        if (a.short || a.porcelain) {
            return mg.statusText({ porcelain: !!a.porcelain, short: !!a.short, branch: !!a.branch });
        }
        const matrix = await git.statusMatrix({ fs: mg.fs, dir: mg.dir });
        const current = (await mg.currentBranch()) ?? 'HEAD';
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
    },
};

export default status;
