import mri from 'mri';
import type { Command } from './types.js';

/**
 * `git show-ref --tags [-d]`.
 *
 * Default emits the OID the ref *itself* stores — for annotated tags that's
 * the tag object's OID (NOT the commit it points at), matching native git.
 * With `-d`/`--dereference`, annotated tags get an additional `^{}` line
 * carrying the peeled commit OID, again matching `git show-ref -d`. The
 * old behavior (emitting the peeled commit OID by default) was a divergence
 * from git that broke callers relying on `show-ref --tags` output to
 * identify the tag object itself (e.g. `git update-ref refs/tags/X <oid>`).
 */
const showRef: Command = {
    names: ['show-ref'],
    async run({ mg }, args) {
        const a = mri(args, {
            alias: { d: 'dereference' },
            boolean: ['tags', 'dereference', 'head'],
        });
        if (!a.tags) {
            throw new Error('memory-git: only `show-ref --tags` is supported');
        }
        const refs = await mg.showTagRefs();
        if (refs.length === 0) return '';
        const out: string[] = [];
        for (const r of refs) {
            out.push(`${r.refOid} refs/tags/${r.tagName}`);
            // `-d` adds the peeled `^{}` line, but only when the ref actually
            // dereferences — i.e. annotated tags whose tag-object OID differs
            // from the commit. Lightweight tags have refOid === commitOid;
            // emitting `^{}` for them would diverge from git, which omits it.
            if (a.dereference && r.refOid !== r.commitOid) {
                out.push(`${r.commitOid} refs/tags/${r.tagName}^{}`);
            }
        }
        return out.join('\n');
    },
};

export default showRef;
