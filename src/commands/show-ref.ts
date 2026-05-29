import mri from 'mri';
import type { Command } from './types.js';

/**
 * `git show-ref [--heads] [--tags] [-d]`.
 *
 * Default (no flags) emits every ref — heads + tags + remotes — matching
 * native git. `--heads`/`--tags` filter to that subset (combinable). `-d`
 * adds the peeled `^{}` line for annotated tags (whose ref OID is the
 * tag-object OID, not the commit).
 *
 * Each emitted line is `<oid> <full-ref-name>`; for annotated tags under `-d`
 * there's a second line `<peeled-commit-oid> refs/tags/<name>^{}`. Matches
 * `git show-ref` byte-for-byte for the common cases.
 */
const showRef: Command = {
    names: ['show-ref'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { d: 'dereference' },
            boolean: ['tags', 'heads', 'dereference', 'head'],
        });
        const explicit = !!a.tags || !!a.heads;
        const refs = await mg.showRefs({
            // No explicit filter ⇒ everything (native git's default).
            // Explicit ⇒ only what was asked for.
            heads: explicit ? !!a.heads : true,
            tags:  explicit ? !!a.tags  : true,
            remotes: explicit ? false   : true,
        });
        if (refs.length === 0) return '';
        const out: string[] = [];
        for (const r of refs) {
            out.push(`${r.oid} ${r.ref}`);
            // `-d` adds the peeled `^{}` line, but ONLY when the ref
            // dereferences — i.e. annotated tags (ref.peeled is set).
            // Lightweight tags have no peeled and stay single-line, matching git.
            if (a.dereference && r.peeled) {
                out.push(`${r.peeled} ${r.ref}^{}`);
            }
        }
        return out.join('\n');
    },
};

export default showRef;
