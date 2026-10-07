import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
    domainTokenId,
    parseAddress,
    recordChanges,
    siteKindOf,
    siteProblem,
    siteRecords,
    splitDomain,
    validLabel,
    zoneFromToken,
    zoneTokenNaming,
} from '@/lib/wallet/domains';
import { launchProblem } from '@/lib/wallet/launchpad';

/**
 * The pure rules behind domains in the wallet.
 *
 * `zoneFromToken` and the token id restate CyberiaDomains; if they drift, the
 * launch screen promises a zone the contract will refuse, or the wallet reads
 * somebody else's token as yours. The address bar decides what a typed string
 * *is*, which is the difference between resolving a Cyberia name and sending
 * the user to a stranger's https site of the same spelling.
 */

const ZONES = ['cyber', 'moon'];

test('a zone is spelled by the name and the ticker together, case folded', () => {
    assert.equal(zoneFromToken('.moon', 'DOTMOON'), 'moon');
    assert.equal(zoneFromToken('.Moon', 'DotMoon'), 'moon');
    assert.equal(zoneFromToken('.my-zone', 'DOTMY-ZONE'), 'my-zone');

    for (const [name, symbol] of [
        ['moon', 'DOTMOON'],
        ['.moon', 'MOON'],
        ['.moon', 'DOTMARS'],
        ['.mo on', 'DOTMO ON'],
        ['.', 'DOT'],
        ['.-x', 'DOT-X'],
        ['.луна', 'DOTЛУНА'],
    ]) {
        assert.equal(zoneFromToken(name, symbol), null, `${name}/${symbol}`);
    }

    assert.deepEqual(zoneTokenNaming('moon'), {
        name: '.moon',
        symbol: 'DOTMOON',
    });
});

test('a zone ticker may be longer than an ordinary one, nothing else may', () => {
    const form = (name, symbol) => ({
        name,
        symbol,
        supply: '1000',
        liquidity: '10',
        creatorFeePct: '1',
        holdersSharePct: '0',
    });

    assert.equal(
        launchProblem(form('.cyberpunks', 'DOTCYBERPUNKS'), 'v2', null),
        null,
    );
    assert.equal(
        launchProblem(form('Cyberpunks', 'DOTCYBERPUNKS'), 'v2', null),
        'symbol',
    );
});

test('the token id is keccak256(label + "." + zone), as abi.encodePacked builds it', () => {
    assert.equal(
        domainTokenId('lain', 'cyber'),
        BigInt(keccak256(toUtf8Bytes('lain.cyber'))),
    );
});

test('labels follow the DNS hostname rule', () => {
    for (const ok of ['a', 'lain', 'x-1', '0', 'a'.repeat(63)]) {
        assert.equal(validLabel(ok), true, ok);
    }

    for (const bad of ['', '-a', 'a-', 'Lain', 'a.b', 'a_b', 'a'.repeat(64)]) {
        assert.equal(validLabel(bad), false, bad);
    }
});

test('a name is a domain only in a served zone', () => {
    assert.deepEqual(splitDomain('LAIN.moon.', ZONES), {
        label: 'lain',
        zone: 'moon',
        sub: '',
    });
    assert.deepEqual(splitDomain('www.lain.cyber', ZONES), {
        label: 'lain',
        zone: 'cyber',
        sub: 'www',
    });
    assert.equal(splitDomain('lain.mars', ZONES), null);
    assert.equal(splitDomain('cyber', ZONES), null);
});

test('the address bar tells domains, web addresses and nonsense apart', () => {
    assert.deepEqual(parseAddress('lain.moon', ZONES), {
        kind: 'domain',
        name: 'lain.moon',
        path: '/',
    });
    assert.deepEqual(parseAddress('http://Lain.Cyber/a?b=1', ZONES), {
        kind: 'domain',
        name: 'lain.cyber',
        path: '/a?b=1',
    });
    assert.deepEqual(parseAddress('example.com/x', ZONES), {
        kind: 'url',
        url: 'https://example.com/x',
    });
    assert.deepEqual(parseAddress('ipfs://bafyabc/page.html', ZONES), {
        kind: 'url',
        url: 'https://ipfs.io/ipfs/bafyabc/page.html',
    });
    // A zone this server does not serve is somebody else's name.
    assert.equal(parseAddress('lain.mars', ZONES).kind, 'url');

    for (const bad of ['', 'hello', 'javascript:alert(1)', 'ftp://x.y']) {
        assert.deepEqual(parseAddress(bad, ZONES), { kind: 'invalid' }, bad);
    }
});

test('a site form writes its own key and clears the others', () => {
    const base = {
        kind: 'url',
        url: ' https://example.org ',
        ipfs: 'old',
        alias: '',
        ipv4: '',
        ipv6: '',
    };

    assert.deepEqual(siteRecords(base), {
        url: 'https://example.org',
        ipfs: '',
        CNAME: '',
        A: '',
        AAAA: '',
    });
    assert.deepEqual(
        siteRecords({ ...base, kind: 'host', ipv4: '1.2.3.4, 5.6.7.8' }).A,
        '1.2.3.4 5.6.7.8',
    );
    assert.equal(
        siteRecords({ ...base, kind: 'ipfs', ipfs: 'ipfs://bafyxyz' }).ipfs,
        'bafyxyz',
    );
    assert.equal(siteKindOf({ CNAME: 'x.com', A: '1.1.1.1' }), 'alias');
    assert.equal(siteKindOf({}), 'none');
});

test('a site form says what is wrong before anything is signed', () => {
    const form = (overrides) => ({
        kind: 'none',
        url: '',
        ipfs: '',
        alias: '',
        ipv4: '',
        ipv6: '',
        ...overrides,
    });

    assert.equal(
        siteProblem(form({ kind: 'url', url: 'example.org' })),
        'domainBadUrl',
    );
    assert.equal(
        siteProblem(form({ kind: 'ipfs', ipfs: 'hello' })),
        'domainBadCid',
    );
    assert.equal(
        siteProblem(
            form({
                kind: 'ipfs',
                ipfs: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
            }),
        ),
        null,
    );
    assert.equal(
        siteProblem(form({ kind: 'alias', alias: 'not a host' })),
        'domainBadAlias',
    );
    assert.equal(
        siteProblem(form({ kind: 'host', ipv4: '300.1.1.1' })),
        'domainBadIp',
    );
    assert.equal(
        siteProblem(form({ kind: 'host', ipv6: '2001:db8::1' })),
        null,
    );
    assert.equal(siteProblem(form()), null);
});

test('only changed records are written, and a cleared one is deleted', () => {
    assert.deepEqual(
        recordChanges(
            { url: 'https://a', TXT: 'hi' },
            { url: 'https://a', ipfs: '', TXT: '', A: '1.1.1.1' },
        ),
        { keys: ['TXT', 'A'], values: ['', '1.1.1.1'] },
    );
});
