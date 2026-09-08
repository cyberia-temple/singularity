import assert from 'node:assert/strict';
import test from 'node:test';
import {
    V3_FEE_TIERS,
    encodeV3Path,
    sortTokens,
    v3PoolAddress,
    v3PriceFromSqrt,
    v3RouteFeePct,
} from '@/lib/dexV3';
import { liquidityChainById } from '@/lib/liquidityChains';

/**
 * The parts of v3 trading that are arithmetic rather than a call.
 *
 * All three of them fail silently when they are wrong, which is why they are
 * pinned: a pool address derived from the wrong salt is a plausible address
 * with nothing at it, a path packed wrong is a revert nobody can read, and a
 * fee taken from the tier instead of the pool advertises a launch pool at 11%
 * when it charges 3%.
 */

const CYBERIA = 49406;
const WCYBER = '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9';
const XMR = '0xe2E8D51C18d6e0FDDbb9Ff4BF63235D688dd00Ae';

const v3 = () => {
    const cfg = liquidityChainById(CYBERIA).v3;
    assert.ok(cfg, 'Cyberia must carry a v3 stack');

    return cfg;
};

test('a pool key is ordered by address, both ways round', () => {
    const [a, b] = sortTokens(WCYBER, XMR);
    const [c, d] = sortTokens(XMR, WCYBER);

    assert.equal(a, c);
    assert.equal(b, d);
    assert.ok(a.toLowerCase() < b.toLowerCase());
    assert.throws(() => sortTokens(WCYBER, WCYBER), /two different tokens/);
});

test('a pool address does not depend on the order the pair was named in', () => {
    const cfg = v3();

    assert.equal(
        v3PoolAddress(cfg, WCYBER, XMR, 2500),
        v3PoolAddress(cfg, XMR, WCYBER, 2500),
    );
});

test('the address matches what the contracts themselves derived', () => {
    // Not a fixture: LaunchpadV3.launch() was run against the live Cyberia
    // stack as an eth_call on 2026-09-07 and answered with this token and this
    // pool. If this ever fails, the periphery and this screen are addressing
    // different contracts, and every quote on the page is for a pool that is
    // not there.
    assert.equal(
        v3PoolAddress(
            v3(),
            '0xB17aDFbCD2DEE9e119EF2D856b0598b152323DeE',
            WCYBER,
            110_000,
        ),
        '0x75dA5949CEA6D4ed06AbD0ADc7B310B03bAD29CB',
    );
});

test('every tier is a different pool', () => {
    const cfg = v3();
    const seen = new Set(
        V3_FEE_TIERS.map((tier) => v3PoolAddress(cfg, WCYBER, XMR, tier)),
    );

    assert.equal(seen.size, V3_FEE_TIERS.length);
});

test('the init code hash decides every address', () => {
    const cfg = v3();
    const wrong = {
        ...cfg,
        // The hash of the stack that was superseded on 2026-09-07.
        initCodeHash:
            '0x251f3613d122be961cc7c764fdb88d1f6d9237cbc2bcadbf0bc5450e87eecf37',
    };

    assert.notEqual(
        v3PoolAddress(cfg, WCYBER, XMR, 2500),
        v3PoolAddress(wrong, WCYBER, XMR, 2500),
        'a stale init code hash must not address the live pool',
    );
});

test('a path is token, tier, token — and the tier is three bytes', () => {
    const single = encodeV3Path([WCYBER, XMR], [2500]);
    // 20 + 3 + 20 bytes, hex-encoded, plus 0x
    assert.equal(single.length, 2 + (20 + 3 + 20) * 2);
    assert.ok(single.toLowerCase().startsWith(WCYBER.toLowerCase()));
    assert.ok(single.toLowerCase().endsWith(XMR.slice(2).toLowerCase()));

    const two = encodeV3Path([WCYBER, XMR, WCYBER], [2500, 110_000]);
    assert.equal(two.length, 2 + (20 + 3 + 20 + 3 + 20) * 2);
    // 110000 = 0x01ADB0 — the launch tier, packed as three bytes
    assert.ok(two.toLowerCase().includes('01adb0'));
});

test('a path with the wrong number of fees is refused, not packed', () => {
    assert.throws(() => encodeV3Path([WCYBER, XMR], [2500, 500]), /one fee/);
    assert.throws(() => encodeV3Path([WCYBER], [2500]), /one fee/);
    assert.throws(() => encodeV3Path([WCYBER, XMR, WCYBER], [2500]), /one fee/);
});

test("a route's cost is the pools' own fees, never the tiers it was addressed by", () => {
    // A launch pool: born in the 11% tier, lowered to 3% before it traded.
    const launchPool = { tier: 110_000, fee: 30_000 };

    assert.equal(v3RouteFeePct([launchPool]), 3);
    assert.equal(v3RouteFeePct([launchPool, { tier: 2500, fee: 2500 }]), 3.25);
    assert.equal(v3RouteFeePct([]), 0);
});

test('a sqrt price reads back as a price, decimals included', () => {
    // sqrt(1) << 96 — one for one between two 18-decimal tokens.
    const one = 79228162514264337593543950336n;

    assert.ok(Math.abs(v3PriceFromSqrt(one, 18, 18) - 1) < 1e-9);
    // XMR has 12 decimals against WCYBER's 18: the raw ratio is off by 1e-6.
    assert.ok(Math.abs(v3PriceFromSqrt(one, 12, 18) - 1e-6) < 1e-12);
    assert.equal(v3PriceFromSqrt(0n, 18, 18), 0);
});
