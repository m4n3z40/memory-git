import mri from 'mri';
import type { Command } from './types.js';

const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatGitDate(isoTs: string, tzMin: number = 0): string {
    // Match native git's default date shape: `Thu Jan 1 00:00:00 2026 +0000`.
    // `tzMin` is minutes west of UTC; emitted ±HHMM has the inverted sign
    // (west-of-UTC → negative HHMM), matching git's `commit` object format.
    const adj = new Date(new Date(isoTs).getTime() - tzMin * 60_000);
    const day = days[adj.getUTCDay()];
    const mon = months[adj.getUTCMonth()];
    const hh = String(adj.getUTCHours()).padStart(2,'0');
    const mm = String(adj.getUTCMinutes()).padStart(2,'0');
    const ss = String(adj.getUTCSeconds()).padStart(2,'0');
    const sign = tzMin > 0 ? '-' : '+';
    const abs = Math.abs(tzMin);
    const tzH = String(Math.floor(abs/60)).padStart(2,'0');
    const tzM = String(abs%60).padStart(2,'0');
    return `${day} ${mon} ${adj.getUTCDate()} ${hh}:${mm}:${ss} ${adj.getUTCFullYear()} ${sign}${tzH}${tzM}`;
}

const show: Command = {
    names: ['show'],
    async run({ mg }, args) {
        const a = mri(args);
        const spec = a._[0] ? String(a._[0]) : 'HEAD';

        // `git show <ref>:<path>` prints the blob contents at that path in
        // the given ref (cat-file in disguise). We split on the FIRST colon
        // so refs like `refs/heads/main:src/x.ts` keep the path intact.
        const colon = spec.indexOf(':');
        if (colon >= 0) {
            const ref = spec.slice(0, colon) || 'HEAD';
            const filepath = spec.slice(colon + 1);
            const content = await mg.readFileAtRef(filepath, ref);
            return typeof content === 'string' ? content : content.toString('utf8');
        }

        const r = await mg.show(spec);
        const lines: string[] = [`commit ${r.commit.sha}`];
        // Native git emits `Merge: <p1> <p2>` between commit line and Author:
        // for merge commits. Matches `git show` byte-for-byte for the header.
        const isMerge = r.parents.length > 1;
        if (isMerge) {
            lines.push(`Merge: ${r.parents.map(p => p.slice(0, 7)).join(' ')}`);
        }
        lines.push(
            `Author: ${r.commit.author} <${r.commit.email}>`,
            `Date:   ${formatGitDate(r.commit.timestamp, r.commit.authorTzMin)}`,
            '',
            `    ${r.commit.message.trim().replace(/\n/g, '\n    ')}`,
            '',
        );
        // Native `git show` on a merge commit emits an empty diff by default
        // (you need `-m`/`-c` to see per-parent changes), so we follow suit.
        // For non-merge commits we still emit the legacy file-status summary
        // — proper unified-diff output is a separate (larger) parity feature.
        if (!isMerge) {
            lines.push(...r.changes.map(c => `${c.status[0].toUpperCase()}\t${c.filepath}`));
        }
        return lines.join('\n');
    },
};

export default show;
