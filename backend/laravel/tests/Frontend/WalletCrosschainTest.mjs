import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CROSS_NATIVE,
    crossDestinationProblem,
    crossDestinationValidator,
    crossFeeShareBps,
    crossSourceProblem,
    parseCrossQuote,
    preferredDestination,
} from '@/lib/wallet/crosschain';

/**
 * A cross-chain swap has no cancel: one signature deposits, and everything
 * after it belongs to a router. So the parts pinned here are the ones that
 * decide what gets signed at all — which chain may be the source, which
 * address may be the destination, and what the fee actually came to.
 *
 * The fee is the load-bearing one. This app *asks* for basis points; the
 * router is free to cap, round or decline them, and the only number a screen
 * may show is the one read back out of the answered quote.
 */

const evmChain = (overrides = {}) => ({
    id: 8453,
    name: 'Base',
    symbol: 'ETH',
    decimals: 18,
    vm: 'evm',
    explorer: 'https://basescan.org',
    tokens: 'All',
    deposits: true,
    ...overrides,
});

const walletChainOf = (chainId) => (chainId === 8453 ? 'base' : null);

test('a source has to be routed, EVM, taking deposits, and switched on here', () => {
    assert.equal(crossSourceProblem(evmChain(), ['base'], walletChainOf), null);

    // Not in the router's list at all.
    assert.equal(
        crossSourceProblem(null, ['base'], walletChainOf),
        'notRouted',
    );

    // The origin leg is the transaction this wallet signs, and it can only
    // sign an EVM one — better refused here than after the hold button.
    assert.equal(
        crossSourceProblem(
            evmChain({ id: 792703809, vm: 'svm' }),
            ['base'],
            walletChainOf,
        ),
        'notEvm',
    );

    assert.equal(
        crossSourceProblem(
            evmChain({ deposits: false }),
            ['base'],
            walletChainOf,
        ),
        'noDeposits',
    );

    // A network that is off in this wallet has no endpoint to broadcast
    // through and no balance the user has seen. Fixable, and named as such.
    assert.equal(
        crossSourceProblem(evmChain(), [], walletChainOf),
        'notInWallet',
    );
    assert.equal(
        crossSourceProblem(evmChain({ id: 42161 }), ['base'], walletChainOf),
        'notInWallet',
    );
});

test('a destination is refused unless this wallet can check its addresses', () => {
    assert.equal(crossDestinationProblem(evmChain()), null);
    assert.equal(
        crossDestinationProblem(evmChain({ id: 792703809, vm: 'svm' })),
        null,
    );
    assert.equal(
        crossDestinationProblem(evmChain({ id: 8253038, vm: 'bvm' })),
        null,
    );

    // TON, Tron and the rest: the router delivers there, this wallet has no
    // way to tell a typo from an address, and a swap cannot be recalled.
    assert.equal(
        crossDestinationProblem(evmChain({ id: 728126428, vm: 'tvm' })),
        'unverifiable',
    );
    assert.equal(crossDestinationProblem(null), 'notRouted');
});

test('each destination is checked by its own chain’s rules', () => {
    const evm = crossDestinationValidator(evmChain());
    assert.ok(evm('0x2222222222222222222222222222222222222222'));
    assert.ok(!evm('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK'));
    assert.ok(!evm('0x22'));

    const solana = crossDestinationValidator(
        evmChain({ id: 792703809, vm: 'svm' }),
    );
    assert.ok(solana('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK'));
    assert.ok(!solana('0x2222222222222222222222222222222222222222'));

    const bitcoin = crossDestinationValidator(
        evmChain({ id: 8253038, vm: 'bvm' }),
    );
    assert.ok(bitcoin('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'));
    // Legacy and P2SH are somebody else's address to receive at; the wallet
    // cannot spend from them, which is a different question.
    assert.ok(bitcoin('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'));
    assert.ok(!bitcoin('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'));
    assert.ok(!bitcoin('not-an-address'));

    assert.equal(crossDestinationValidator(evmChain({ vm: 'tonvm' })), null);
});

test('the fee shown is the one in the quote, never the one asked for', () => {
    const quote = parseCrossQuote({
        requestId: '0xabc',
        steps: [],
        in: { symbol: 'ETH', decimals: 18, amount: '10000000000000000' },
        out: { symbol: 'SOL', decimals: 9, amount: '225034122' },
        fees: {
            app: {
                symbol: 'ETH',
                decimals: 18,
                amount: '75000000000000',
                usd: '0.18',
            },
        },
        feeRequested: true,
        feeApplied: true,
    });

    // 0.000075 of 0.01 — 75 bps, read back out of the answer.
    assert.equal(crossFeeShareBps(quote), 75);

    // A route the router declined to charge on: null, so the screen says the
    // fee was not applied instead of printing the configured percentage.
    assert.equal(
        crossFeeShareBps({ ...quote, fees: { ...quote.fees, app: null } }),
        null,
    );
    assert.equal(
        crossFeeShareBps({
            ...quote,
            fees: { ...quote.fees, app: { ...quote.fees.app, amount: 0n } },
        }),
        null,
    );

    // A fee charged in something other than the input cannot be a share of it,
    // and a nonsense percentage is worse than none.
    assert.equal(
        crossFeeShareBps({
            ...quote,
            fees: { ...quote.fees, app: { ...quote.fees.app, decimals: 6 } },
        }),
        null,
    );
});

test('the wire form becomes bigints, and an absent price stays absent', () => {
    const quote = parseCrossQuote({
        requestId: '0xabc',
        steps: [
            {
                id: 'approve',
                description: 'Allowance',
                items: [
                    {
                        chainId: 8453,
                        to: '0xtoken',
                        data: '0x095ea7b3',
                        value: '0',
                        gas: '70000',
                        maxFeePerGas: '6500000',
                        maxPriorityFeePerGas: null,
                    },
                ],
            },
        ],
        in: {
            symbol: 'ETH',
            decimals: 18,
            amount: '10000000000000000',
            usd: '25.13',
        },
        out: {
            symbol: 'SOL',
            decimals: 9,
            amount: '225034122',
            minimum: '220533440',
            usd: '',
        },
        fees: {},
        timeEstimate: 12,
        slippageBps: 200,
    });

    assert.equal(quote.in.amount, 10_000_000_000_000_000n);
    assert.equal(quote.out.minimum, 220_533_440n);
    assert.equal(quote.steps[0].items[0].value, 0n);
    assert.equal(quote.steps[0].items[0].gas, 70_000n);
    // Absent rather than defaulted: a limit nobody stated is one ethers fills
    // in, not one this wallet invents.
    assert.equal(quote.steps[0].items[0].maxPriorityFeePerGas, null);
    assert.equal(quote.in.usd, 25.13);
    // A price the router did not have is null and never 0 — the screens render
    // "—" for one and a claim about value for the other.
    assert.equal(quote.out.usd, null);
    assert.equal(quote.fees.app, null);

    // An amount that is missing entirely is a refusal, not a zero-value swap.
    assert.throws(() => parseCrossQuote({ requestId: '0x', steps: [] }));
});

test('the coin of a chain is addressed the way the router addresses it', () => {
    assert.equal(CROSS_NATIVE, '0x0000000000000000000000000000000000000000');
});

test('a cross-chain swap opens on bitcoin when the wallet holds a bitcoin account', () => {
    const base = { id: 8453, vm: 'evm' };
    const solana = { id: 792703809, vm: 'svm' };
    const bitcoin = { id: 8253038, vm: 'bvm' };

    assert.equal(preferredDestination([base, solana, bitcoin]), bitcoin);
    assert.equal(preferredDestination([base, solana]), solana);
    assert.equal(preferredDestination([base]), base);
    assert.equal(preferredDestination([]), undefined);
});
