import mri from 'mri';
import type { Command } from './types.js';

/**
 * `git describe [--exact-match] [--tags] [--abbrev=<n>] [<ref>]`.
 *
 *   - `--exact-match`: only emit when the ref *is* the tagged commit; throw
 *     otherwise. Backed by `mg.describeExact` for the legacy fast path.
 *   - default (no `--exact-match`): walk parents from the ref to the nearest
 *     tag and emit `<tag>-<N>-g<short>` (or just `<tag>` when N=0). Backed
 *     by `mg.describe`, which uses BFS to find the nearest tag and
 *     `revListCount` to make N merge-DAG-accurate.
 *   - `--tags`: include lightweight tags in the candidate set (default is
 *     annotated-only, matching native git).
 *   - `--abbrev=<n>`: width of the short hash suffix (default 7).
 */
const describe: Command = {
    names: ['describe'],
    async run({ mg }, args) {
        const a = mri(args, {
            boolean: ['exact-match', 'tags'],
            string: ['abbrev'],
        });
        const ref = a._[0] ? String(a._[0]) : 'HEAD';
        const abbrev = a.abbrev != null ? Number(a.abbrev) : undefined;

        if (a['exact-match']) {
            // Native `--exact-match` (no `--tags`) only considers ANNOTATED
            // tags — lightweight tags at the same commit produce "no tag
            // exactly matches" even though they're real refs. Match that by
            // cross-checking the returned tag against showTagRefs: annotated
            // iff refOid !== commitOid (the ref points at a tag object, not
            // the commit). `--tags` opts back into the legacy "any tag"
            // behavior.
            const tag = await mg.describeExact(ref);
            if (tag === null) {
                throw new Error(`fatal: no tag exactly matches '${ref}'`);
            }
            if (!a.tags) {
                const refs = await mg.showTagRefs();
                const entry = refs.find(r => r.tagName === tag);
                if (!entry || entry.refOid === entry.commitOid) {
                    throw new Error(`fatal: no tag exactly matches '${ref}'`);
                }
            }
            return tag;
        }
        return mg.describe(ref, { tags: !!a.tags, abbrev });
    },
};

export default describe;
