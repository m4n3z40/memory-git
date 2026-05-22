import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

/**
 * These tests verify that fetch / push / pull route URL-shaped strings
 * to the `url` parameter (vs `remote`) so callers can do ad-hoc fetches
 * without pre-configuring a remote — matching `git fetch <url>` behavior.
 *
 * We don't hit the network — we assert that the typed/exec layer gets
 * past the "remote OR url" check inside isomorphic-git. The downstream
 * network call fails with a different error (DNS, HTTP, transport), and
 * that's the signal that URL routing worked.
 */

const FAKE_URL = 'https://memory-git.invalid.example.com/test/repo.git';
const REMOTE_OR_URL_ERR = /requires a "remote OR url"/;

async function setupRepo(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    mg.setAuthor('T', 't@t');
    await mg.init();
    await mg.writeFile('a', '1'); await mg.add('.'); await mg.commit('c1');
    return mg;
}

describe('fetch URL routing', () => {
    let mg: MemoryGit;
    beforeEach(async () => { mg = await setupRepo('fetch-url'); });

    it('typed fetch(string) routes a URL to url, not remote', async () => {
        await expect(mg.fetch(FAKE_URL)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('typed fetch({ url, ref }) reaches the network layer', async () => {
        await expect(mg.fetch({ url: FAKE_URL, ref: 'main' })).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('typed fetch({ remote: "origin" }) still fails with the "remote OR url" error when origin is unconfigured', async () => {
        // Sanity check that we didn't accidentally always route to url
        await expect(mg.fetch({ remote: 'origin' })).rejects.toThrow(REMOTE_OR_URL_ERR);
    });

    it('exec fetch <url> [<ref>] passes the URL through', async () => {
        await expect(mg.exec(`git fetch ${FAKE_URL} main`)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('exec fetch <url> (no ref) passes the URL through', async () => {
        await expect(mg.exec(`git fetch ${FAKE_URL}`)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('exec fetch <name> still looks up a configured remote', async () => {
        await mg.addRemote('upstream', FAKE_URL);
        await expect(mg.exec('git fetch upstream main')).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('seeds a default refspec on ad-hoc URL fetch', async () => {
        // Fire-and-ignore the (failing) network call so the pre-network setup runs
        await mg.fetch({ url: FAKE_URL, ref: 'main' }).catch(() => undefined);
        const refspec = await mg.config('remote.origin.fetch');
        expect(refspec).toBe('+refs/heads/*:refs/remotes/origin/*');
    });
});

describe('push URL routing', () => {
    let mg: MemoryGit;
    beforeEach(async () => { mg = await setupRepo('push-url'); });

    it('typed push({ url, ref }) reaches the network layer', async () => {
        await expect(mg.push({ url: FAKE_URL, ref: 'main' })).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('typed push(url-string) routes to url', async () => {
        await expect(mg.push(FAKE_URL)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('exec push <url> <ref> routes positional URL', async () => {
        await expect(mg.exec(`git push ${FAKE_URL} main`)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('exec push <url> --force <ref> still parses the force flag', async () => {
        await expect(mg.exec(`git push ${FAKE_URL} --force main`)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });
});

describe('pull URL routing', () => {
    let mg: MemoryGit;
    beforeEach(async () => { mg = await setupRepo('pull-url'); });

    it('typed pull({ url, branch }) reaches the network layer', async () => {
        await expect(mg.pull({ url: FAKE_URL, branch: 'main' })).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });

    it('exec pull <url> <branch> routes positional URL', async () => {
        await expect(mg.exec(`git pull ${FAKE_URL} main`)).rejects.not.toThrow(REMOTE_OR_URL_ERR);
    });
});

describe('URL detection heuristic', () => {
    let mg: MemoryGit;
    beforeEach(async () => { mg = await setupRepo('url-detect'); });

    it.each([
        ['https://github.com/o/r.git', true],
        ['http://gitserver.local/r.git', true],
        ['git://example.com/r.git', true],
        ['ssh://git@host/r.git', true],
        ['file:///tmp/r.git', true],
        ['git@github.com:o/r.git', true],
        ['user@host:path', true],
        ['origin', false],
        ['upstream', false],
        ['my-remote-name', false],
    ])('classifies %s as URL=%s', async (input, isUrl) => {
        // Run via typed fetch and check whether the routing went through url or remote.
        // If detected as URL → reaches network/protocol layer (no "remote OR url" error).
        // If detected as name → fails with "remote OR url" because the name isn't configured.
        const promise = mg.fetch(input).catch((e: Error) => e);
        const err = await promise;
        const wentToRemote = err instanceof Error && REMOTE_OR_URL_ERR.test(err.message);
        if (isUrl) {
            expect(wentToRemote, `${input} should route to url`).toBe(false);
        } else {
            expect(wentToRemote, `${input} should route to remote name`).toBe(true);
        }
    });
});
