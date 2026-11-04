import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress } from 'ethers';
import {
    checkedAddress,
    checkedHash,
    gatewayAbi,
    units,
} from '@/lib/wallet/tokenAdmin';

const holder = '0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393';
const reference = `0x${'ab'.repeat(32)}`;

test('asset amounts are exact, positive and respect each token’s decimals', () => {
    assert.equal(units('12.34', 2), 1234n);
    assert.equal(units('0.000001', 6), 1n);
    assert.throws(() => units('0.001', 2));
    assert.throws(() => units('0', 2));
    assert.throws(() => units('-1', 18));
    assert.equal(units('0', 18, true), 0n);
});

test('a release includes the exact gateway, holder, amount and unique deposit reference', () => {
    const asset = '0x1111111111111111111111111111111111111111';
    const data = gatewayAbi.encodeFunctionData('release', [
        asset,
        holder,
        1234n,
        reference,
    ]);
    const decoded = gatewayAbi.decodeFunctionData('release', data);
    assert.equal(decoded[0], asset);
    assert.equal(decoded[1], holder);
    assert.equal(decoded[2], 1234n);
    assert.equal(decoded[3], reference);
    assert.throws(() => checkedAddress(ZeroAddress));
    assert.throws(() => checkedHash('0x1234'));
    assert.throws(() => checkedHash(`0x${'00'.repeat(32)}`));
});

test('finalization names an outbound request and payout reference, never a holder burn', () => {
    const data = gatewayAbi.encodeFunctionData('finalize', [42n, reference]);
    const decoded = new Interface([
        'function finalize(uint256,bytes32)',
    ]).decodeFunctionData('finalize', data);
    assert.equal(decoded[0], 42n);
    assert.equal(decoded[1], reference);
    assert.equal(gatewayAbi.getFunction('burnFrom'), null);
});

test('a delayed authority cannot be submitted as an immediate wallet call', async () => {
    const { createServer } = await import('node:http');
    const { prepareOperation } = await import('@/lib/wallet/tokenAdmin');
    const gateway = new Interface([
        'function authority() view returns (address)',
    ]);
    const access = new Interface([
        'function canCall(address,address,bytes4) view returns (bool,uint32)',
    ]);
    const calls = [];
    const server = createServer(async (req, res) => {
        let body = '';

        for await (const part of req) {
body += part;
}

        const input = JSON.parse(body);
        calls.push(input.method);
        let result;

        if (input.method === 'eth_chainId') {
result = '0xc0ff';
} else if (input.method === 'eth_getCode') {
result = '0x6000';
} else if (input.method === 'eth_call') {
            const data = input.params[0].data;
            result = data.startsWith(gateway.getFunction('authority').selector)
                ? gateway.encodeFunctionResult('authority', [holder])
                : access.encodeFunctionResult('canCall', [false, 172800]);
        } else {
throw new Error(`Unexpected method: ${input.method}`);
}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        await assert.rejects(
            prepareOperation(
                {
                    operation: 'finalize',
                    args: [1n, reference],
                    account: holder,
                },
                `http://127.0.0.1:${server.address().port}`,
            ),
            /scheduled authority operation/,
        );
        assert.ok(!calls.includes('eth_estimateGas'));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
