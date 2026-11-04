import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import {
    FEE_FIELDS,
    canManage,
    clearingFees,
    feeConfigCalldata,
    feeRecipientCalldata,
    minBaseFeeForTransfer,
    transferCost,
    transfersLeft,
} from '@/lib/wallet/chainAdmin';
import { networksOn } from '@/lib/wallet/catalogue';
import { isCoreChain, shippedChainByEvmId } from '@/lib/wallet/chains';

const ETH_PRICED_MIN = 7_200_000_000_000_000n;

test('a transfer price in CYBER sets the minimum base fee, and back', () => {
    assert.equal(minBaseFeeForTransfer('151.2'), ETH_PRICED_MIN);
    assert.equal(transferCost(ETH_PRICED_MIN), 151_200_000_000_000_000_000n);
    assert.equal(transfersLeft(10_000n * 10n ** 18n, ETH_PRICED_MIN), 66n);
});

/**
 * Right after the minimum goes up, the latest block still charges the old
 * fee. A bid priced from it alone never lands, so the panel bids from the
 * higher of the two.
 */
test('fees clear the next block even when the minimum just went up', () => {
    assert.deepEqual(clearingFees(1n, ETH_PRICED_MIN), {
        maxFeePerGas: 2n * ETH_PRICED_MIN,
        maxPriorityFeePerGas: 1n,
    });
    assert.equal(
        clearingFees(9n * ETH_PRICED_MIN, ETH_PRICED_MIN).maxFeePerGas,
        18n * ETH_PRICED_MIN,
    );
});

test('setFeeConfig carries every field in the order FeeManager takes them', () => {
    const config = Object.fromEntries(
        FEE_FIELDS.map((field, index) => [field, String(index + 1)]),
    );
    const data = feeConfigCalldata({
        ...config,
        minBaseFee: String(ETH_PRICED_MIN),
    });
    const abi = new Interface([
        'function setFeeConfig(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
    ]);

    assert.ok(data.startsWith('0x8f10b586'));
    assert.deepEqual(abi.decodeFunctionData('setFeeConfig', data).map(String), [
        '1',
        '2',
        String(ETH_PRICED_MIN),
        '4',
        '5',
        '6',
        '7',
        '8',
    ]);
});

test('fees go to one address, or back to block producers, but never get burned by accident', () => {
    assert.equal(feeRecipientCalldata(null), '0x0329099f');
    assert.ok(
        feeRecipientCalldata(
            '0x96cd117786ebc0fdbef56a6559feb2bd2bae3393',
        ).startsWith('0x5e00e679'),
    );
    assert.throws(() =>
        feeRecipientCalldata('0x0000000000000000000000000000000000000000'),
    );
    assert.throws(() => feeRecipientCalldata('not an address'));
});

test('only an account on the allow list gets the controls', () => {
    assert.equal(canManage(null), false);
    assert.equal(canManage(undefined), false);
    assert.equal(canManage(0), false);
    assert.equal(canManage(1), true);
    assert.equal(canManage(2), true);
});

test('Cyberia 2.0 sits beside Cyberia, always on, and the old network stays', () => {
    assert.deepEqual(networksOn({}).slice(0, 2), ['cyberia', 'cyberia_fuji']);
    assert.ok(networksOn({ cyberia_fuji: false }).includes('cyberia_fuji'));
    assert.ok(isCoreChain('cyberia') && isCoreChain('cyberia_fuji'));
    assert.equal(isCoreChain('base'), false);
    assert.equal(shippedChainByEvmId(49407)?.label, 'Cyberia 2.0');
    assert.equal(shippedChainByEvmId(49406)?.label, 'Cyberia');
});

test('connected fee changes reject a different wallet account before sending', async () => {
    const { selectEvmWalletProvider } = await import('@/lib/evmProvider');
    const { submitConnectedFeeConfig } = await import('@/lib/wallet/chainAdmin');
    const methods = [];
    const provider = {
        async request({ method }) {
            methods.push(method);
            if (method === 'eth_chainId') return '0xc0ff';
            if (method === 'eth_accounts') return ['0x0000000000000000000000000000000000000001'];
            throw new Error(`Unexpected request: ${method}`);
        },
    };
    selectEvmWalletProvider({ id: 'test', name: 'test', source: 'legacy', provider });
    try {
        await assert.rejects(
            submitConnectedFeeConfig('0x0000000000000000000000000000000000000002', {
                config: Object.fromEntries(FEE_FIELDS.map((field) => [field, '1'])),
                latestBaseFee: 1n,
                rpcUrl: 'https://example.invalid',
            }),
            /account changed/,
        );
        assert.ok(!methods.includes('eth_sendTransaction'));
    } finally {
        selectEvmWalletProvider(null);
    }
});
