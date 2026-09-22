import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroAddress, parseUnits } from 'ethers';
import {
    feeSplit,
    launchProblem,
    launchTerms,
    launchedFromLogs,
    metadataMessage,
    sqrtPriceQuote,
} from '@/lib/wallet/launchpad';

/**
 * The pure parts of launching a token from the wallet.
 *
 * A launch spends its liquidity for good, so every number that decides what
 * is signed — the fee in the contract's own units, the split printed as a
 * promise, the token read back out of the receipt — is pinned here rather
 * than checked by looking at a screen.
 */

const form = (overrides = {}) => ({
    name: 'Lain Coin',
    symbol: 'LAIN',
    supply: '1000000',
    liquidity: '10',
    creatorFeePct: '1',
    holdersSharePct: '0',
    ...overrides,
});

test('fee split is LaunchpadV3.quote, floors and all', () => {
    // Each row was read from the deployed contract's own `quote()`.
    const cases = [
        [10000, 0, [2, 5000, 0, 5000]],
        [25000, 5000, [3.5, 3571, 3571, 2858]],
        [100000, 10000, [11, 0, 9090, 910]],
        [0, 0, [1, 0, 0, 10000]],
        [33333, 3333, [4.3333, 5129, 2563, 2308]],
    ];

    for (const [fee, share, [poolPct, creator, holders, treasury]] of cases) {
        assert.deepEqual(feeSplit(fee, share), {
            poolFeePct: poolPct,
            creatorBps: creator,
            holdersBps: holders,
            treasuryBps: treasury,
        });
    }
});

test('terms are in the units the contract takes', () => {
    assert.deepEqual(launchTerms('2.5', '50'), {
        creatorFee: 25000,
        holdersShareBps: 5000,
    });
    // Empty is zero — a field left blank is not a refusal.
    assert.deepEqual(launchTerms('', ''), {
        creatorFee: 0,
        holdersShareBps: 0,
    });
    assert.equal(launchTerms('10.01', '0'), null);
    assert.equal(launchTerms('1', '101'), null);
    assert.equal(launchTerms('-1', '0'), null);
});

test('a form names the first thing wrong with it', () => {
    const min = parseUnits('10', 18);

    assert.equal(launchProblem(form(), 'v3', min), null);
    assert.equal(launchProblem(form({ name: '  ' }), 'v3', min), 'name');
    assert.equal(launchProblem(form({ symbol: 'LA IN' }), 'v3', min), 'symbol');
    assert.equal(
        launchProblem(form({ symbol: 'ABCDEFGHIJKLM' }), 'v3', min),
        'symbol',
    );
    assert.equal(launchProblem(form({ supply: '0' }), 'v3', min), 'supply');
    assert.equal(launchProblem(form({ supply: '1e6' }), 'v3', min), 'supply');
    assert.equal(
        launchProblem(form({ liquidity: '9.99' }), 'v3', min),
        'liquidityMin',
    );
    // A floor nobody has read is not a reason to refuse.
    assert.equal(launchProblem(form({ liquidity: '1' }), 'v3', null), null);
    assert.equal(
        launchProblem(form({ creatorFeePct: '11' }), 'v3', min),
        'fee',
    );
    // v2 has no fee, so a fee it cannot take is not its problem.
    assert.equal(launchProblem(form({ creatorFeePct: '11' }), 'v2', min), null);
});

test('a v3 price is read from the token side of the pool', () => {
    const token = '0x0000000000000000000000000000000000000001';
    const other = '0x0000000000000000000000000000000000000002';
    // √(1/4) in Q64.96: token0 is worth a quarter of token1.
    const half = 2n ** 95n;

    assert.equal(sqrtPriceQuote(token, token, half), 0.25);
    assert.equal(sqrtPriceQuote(other, token, half), 4);
    assert.equal(sqrtPriceQuote(token, token, 0n), null);
});

test('the launched token is read only from the launchpad’s own log', () => {
    const launchpad = '0x6970481a167D8D44527091d0E319e50aD3F79Ee3';
    const token = '0x1111111111111111111111111111111111111111';
    const pool = '0x2222222222222222222222222222222222222222';
    const iface = new Interface([
        'event TokenLaunched(address indexed token, address indexed creator, address pool, string name, string symbol, uint256 tokenSupply, uint256 cyberLiquidity)',
    ]);
    const encoded = iface.encodeEventLog('TokenLaunched', [
        token,
        ZeroAddress,
        pool,
        'Lain',
        'LAIN',
        1n,
        1n,
    ]);
    const log = { topics: encoded.topics, data: encoded.data };

    assert.deepEqual(
        launchedFromLogs([{ address: launchpad, ...log }], 'v3', launchpad),
        { token, market: pool },
    );
    // Same event, somebody else's contract: not ours to believe.
    assert.equal(
        launchedFromLogs([{ address: token, ...log }], 'v3', launchpad),
        null,
    );
    assert.equal(
        launchedFromLogs(
            [
                {
                    address: launchpad,
                    topics: [ZeroAddress.padEnd(66, '0')],
                    data: AbiCoder.defaultAbiCoder().encode(['uint256'], [1]),
                },
            ],
            'v3',
            launchpad,
        ),
        null,
    );
});

test('the metadata message is the one LaunchpadController accepts', () => {
    const at = new Date('2026-09-22T10:00:00.000Z');

    assert.equal(
        metadataMessage(
            '0xABCDEF0000000000000000000000000000000001',
            49406,
            at,
        ),
        'Edit Cyberia Launchpad metadata for 0xabcdef0000000000000000000000000000000001 on chain 49406 at 2026-09-22T10:00:00.000Z',
    );
});
