import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Interface } from 'ethers';
import { swapChainFor } from '@/lib/wallet/swap';
import { quoteWrap, WRAP_GAS_CAP } from '@/lib/wallet/wrap';

const abi = new Interface([
    'function deposit() payable',
    'function withdraw(uint256 amount)',
]);
const account = '0x0000000000000000000000000000000000000001';
const mockRpc = async (t, estimate) => {
    const calls = [];
    const server = createServer(async (request, response) => {
        let text = '';

        for await (const chunk of request) {
text += chunk;
}

        const messages = JSON.parse(text);
        const answer = (call) => {
            calls.push(call);

            if (call.method === 'eth_estimateGas') {
                return estimate === null
                    ? {
                          jsonrpc: '2.0',
                          id: call.id,
                          error: { code: -32000, message: 'No estimate' },
                      }
                    : {
                          jsonrpc: '2.0',
                          id: call.id,
                          result: `0x${estimate.toString(16)}`,
                      };
            }

            return { jsonrpc: '2.0', id: call.id, result: '0xc0fe' };
        };
        response.setHeader('Content-Type', 'application/json');
        response.end(
            JSON.stringify(
                Array.isArray(messages)
                    ? messages.map(answer)
                    : answer(messages),
            ),
        );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
        () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    );

    return { calls, url: `http://127.0.0.1:${server.address().port}` };
};

for (const direction of ['wrap', 'unwrap']) {
    test(`${direction} quotes the canonical WCYBER call, exact 1:1 amount and gas fee`, async (t) => {
        const rpc = await mockRpc(t, 40000n),
            amount = 1234567890123456789n;
        const quote = await quoteWrap({
            chainId: 49406,
            direction,
            amount,
            account,
            gasPrice: 1000000000n,
            rpcUrl: rpc.url,
        });
        const tx = rpc.calls.find((call) => call.method === 'eth_estimateGas')
            .params[0];
        assert.equal(
            tx.to.toLowerCase(),
            swapChainFor(49406).wrappedNative.toLowerCase(),
        );
        assert.equal(tx.from.toLowerCase(), account);
        const decoded = abi.parseTransaction({ data: tx.data });
        assert.equal(
            decoded.name,
            direction === 'wrap' ? 'deposit' : 'withdraw',
        );

        if (direction === 'wrap') {
assert.equal(BigInt(tx.value), amount);
} else {
            assert.equal(decoded.args[0], amount);
            assert.equal(tx.value, undefined);
        }

        assert.equal(quote.amount, amount);
        assert.equal(quote.gasLimit, 50000n);
        assert.equal(quote.fee, quote.gasLimit * quote.gasPrice);
    });
}

test('a failed estimate stays within the displayed gas cap', async (t) => {
    const rpc = await mockRpc(t, null);
    const quote = await quoteWrap({
        chainId: 49406,
        direction: 'wrap',
        amount: 1n,
        account,
        gasPrice: 2n,
        rpcUrl: rpc.url,
    });
    assert.equal(quote.gasLimit, WRAP_GAS_CAP);
    assert.equal(quote.fee, WRAP_GAS_CAP * 2n);
});
test('a live estimate above the cap is refused before signing', async (t) => {
    const rpc = await mockRpc(t, 160000n);
    await assert.rejects(
        quoteWrap({
            chainId: 49406,
            direction: 'unwrap',
            amount: 1n,
            account,
            gasPrice: 1n,
            rpcUrl: rpc.url,
        }),
        /more gas/,
    );
});
test('zero or negative amounts never query a node', async (t) => {
    const rpc = await mockRpc(t, 40000n);

    for (const amount of [0n, -1n]) {
await assert.rejects(
            quoteWrap({
                chainId: 49406,
                direction: 'wrap',
                amount,
                account,
                gasPrice: 1n,
                rpcUrl: rpc.url,
            }),
            /Enter an amount/,
        );
}

    assert.equal(rpc.calls.length, 0);
});
