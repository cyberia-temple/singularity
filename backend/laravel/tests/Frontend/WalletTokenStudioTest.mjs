import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, id, parseUnits } from 'ethers';
import { CYBERIA2_LAUNCHPAD } from '@/lib/launchpadChains';
import {
    KIT_ALL,
    formTotalSupply,
    formVenue,
    kitFlags,
    launchArgs,
    launchProblem,
    newestFirst,
} from '@/lib/wallet/launchpad';
import {
    mintRoom,
    tokenActionCall,
    tokenRights,
} from '@/lib/wallet/tokenControl';

/**
 * Tokens made to their creator's description on Cyberia 2.0 (TokenStudio),
 * and running them from the wallet.
 *
 * What is signed is pinned against the deployed contracts' signatures:
 * crypto/protocol/contracts/launch/TokenStudio.sol and tokens/StudioToken.sol.
 */

const me = '0x1111111111111111111111111111111111111111';
const team = '0x2222222222222222222222222222222222222222';
const dao = '0x3333333333333333333333333333333333333333';

const form = (overrides = {}) => ({
    name: 'Lain Coin',
    symbol: 'LAIN',
    supply: '600000000',
    liquidity: '100000',
    creatorFeePct: '1',
    holdersSharePct: '0',
    mintable: false,
    minter: '',
    maxSupply: '',
    allocations: [],
    kit: { credit: true, farm: true, dao: true },
    ...overrides,
});

const min = parseUnits('100000', 18);

test('a plain token stays a launch; minting or addresses make it a studio token', () => {
    assert.equal(formVenue(CYBERIA2_LAUNCHPAD, form()), 'kit');
    assert.equal(
        formVenue(CYBERIA2_LAUNCHPAD, form({ mintable: true, minter: me })),
        'studio',
    );
    assert.equal(
        formVenue(
            CYBERIA2_LAUNCHPAD,
            form({ allocations: [{ to: team, amount: '1' }] }),
        ),
        'studio',
    );
});

test('the studio form checks its addresses, its minter and its ceiling', () => {
    const studio = (overrides) => launchProblem(form(overrides), 'studio', min);

    assert.equal(
        studio({
            mintable: true,
            minter: me,
            maxSupply: '2000000000',
            allocations: [{ to: team, amount: '400000000' }],
        }),
        null,
    );
    assert.equal(
        studio({ allocations: [{ to: '0x12', amount: '1' }] }),
        'allocation',
    );
    assert.equal(
        studio({ allocations: [{ to: team, amount: '0' }] }),
        'allocation',
    );
    assert.equal(
        studio({
            allocations: Array.from({ length: 17 }, () => ({
                to: team,
                amount: '1',
            })),
        }),
        'allocation',
    );
    assert.equal(studio({ mintable: true, minter: 'me' }), 'minter');
    assert.equal(
        studio({
            mintable: true,
            minter: me,
            maxSupply: '700000000',
            allocations: [{ to: team, amount: '400000000' }],
        }),
        'cap',
        'a ceiling below the supply at creation',
    );
    assert.equal(
        studio({ supply: '1000000000001' }),
        'supply',
        'more than a trillion',
    );
    assert.equal(
        formTotalSupply(
            form({ allocations: [{ to: team, amount: '400000000' }] }),
        ),
        parseUnits('1000000000', 18),
    );
});

test('a studio token is the deployed TokenStudio.create, in field order', () => {
    const salt = '0x' + 'cd'.repeat(32);
    const allocations = [{ to: team, amount: parseUnits('400000000', 18) }];
    const quote = {
        venue: 'studio',
        name: 'Lain Coin',
        symbol: 'LAIN',
        supply: parseUnits('600000000', 18),
        creatorFee: 10000,
        holdersShareBps: 2500,
        salt,
        kit: kitFlags({ credit: true, farm: false, dao: true }, 'studio'),
        allocations,
        minter: me,
        maxSupply: parseUnits('2000000000', 18),
    };
    const deployed = new Interface([
        'function create((string,string,uint256,(address,uint256)[],address,uint256,uint24,uint16,bytes32,uint8,string)) payable returns (address)',
    ]);
    const data = deployed.encodeFunctionData('create', [
        [
            'Lain Coin',
            'LAIN',
            parseUnits('600000000', 18),
            [[team, parseUnits('400000000', 18)]],
            me,
            parseUnits('2000000000', 18),
            10000,
            2500,
            salt,
            1 | 8,
            '',
        ],
    ]);
    const ours = new Interface([
        'function create((string name, string symbol, uint256 poolSupply, (address to, uint256 amount)[] allocations, address minter, uint256 maxSupply, uint24 creatorFee, uint16 holdersShareBps, bytes32 salt, uint8 kit, string metadataURI)) payable returns (address)',
    ]).encodeFunctionData('create', launchArgs(quote));

    assert.equal(ours, data);
});

test('the zone is asked of the launchpad only, and no choice is the whole kit', () => {
    assert.equal(kitFlags(undefined, 'kit'), KIT_ALL);
    assert.equal(kitFlags(undefined, 'studio'), 1 | 2 | 8);
    assert.equal(
        kitFlags({ credit: false, farm: false, dao: false }, 'kit'),
        4,
    );
    assert.equal(
        kitFlags({ credit: false, farm: false, dao: false }, 'studio'),
        0,
    );
});

test('the launchpad and the studio are listed together, newest first', () => {
    const at = (address, launchedAt) => ({ address, launchedAt });

    assert.deepEqual(
        newestFirst([at('a', 10), at('b', 30), at('c', null), at('d', 20)]).map(
            (launch) => launch.address,
        ),
        ['b', 'd', 'a', 'c'],
    );
});

const control = (overrides = {}) => ({
    chainId: 49407,
    token: '0x4444444444444444444444444444444444444444',
    registry: '0x5555555555555555555555555555555555555555',
    locker: '0x6666666666666666666666666666666666666666',
    creator: me,
    positionId: 7n,
    kit: { credit: true, farm: false, zone: false, dao: true },
    timelock: dao,
    minter: me,
    maxSupply: parseUnits('2000000000', 18),
    totalSupply: parseUnits('1000000000', 18),
    balance: parseUnits('5', 18),
    burnable: true,
    ...overrides,
});

test('token actions are the deployed StudioToken, LaunchLocker and registry calls', () => {
    const c = control();
    const selector = (signature) => id(signature).slice(0, 10);

    const mint = tokenActionCall(c, {
        kind: 'mint',
        to: team,
        amount: 5n,
    });
    assert.equal(mint.to, c.token);
    assert.equal(mint.data.slice(0, 10), selector('mint(address,uint256)'));

    const handOver = tokenActionCall(c, { kind: 'setMinter', minter: dao });
    assert.equal(handOver.data.slice(0, 10), selector('setMinter(address)'));

    const burn = tokenActionCall(c, { kind: 'burn', amount: 1n });
    assert.equal(burn.data.slice(0, 10), selector('burn(uint256)'));

    const collect = tokenActionCall(c, { kind: 'collect' });
    assert.equal(collect.to, c.locker);
    assert.equal(
        collect.data,
        new Interface(['function collect(uint256)']).encodeFunctionData(
            'collect',
            [7n],
        ),
    );

    const open = tokenActionCall(c, { kind: 'open', part: 'farm' });
    assert.equal(open.to, c.registry);
    assert.equal(open.data.slice(0, 10), selector('openFarm(address)'));
});

test('only what the contracts would accept is offered', () => {
    const mine = tokenRights(control(), me);

    assert.equal(mine.mint, true);
    assert.equal(mine.handOver, true);
    assert.equal(mine.burn, true);
    assert.equal(mine.collect, true);
    assert.deepEqual(mine.open, ['farm']);

    const stranger = tokenRights(control({ balance: 0n }), team);
    assert.equal(stranger.mint, false);
    assert.equal(stranger.handOver, false);
    assert.equal(stranger.burn, false);
    assert.equal(stranger.collect, false);
    assert.deepEqual(stranger.open, ['farm'], 'anyone may open the kit');

    const fixed = control({ minter: null, maxSupply: null });
    assert.equal(tokenRights(fixed, me).mint, false);
    assert.equal(mintRoom(fixed), null);

    const full = control({ totalSupply: parseUnits('2000000000', 18) });
    assert.equal(
        tokenRights(full, me).mint,
        false,
        'nothing left under the ceiling',
    );
    assert.equal(tokenRights(full, me).handOver, true);

    const launched = control({
        burnable: false,
        minter: null,
        maxSupply: null,
    });
    assert.equal(
        tokenRights(launched, me).burn,
        false,
        'a launch token has no burn',
    );
});
