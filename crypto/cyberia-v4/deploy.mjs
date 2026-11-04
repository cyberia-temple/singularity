import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, formatEther, keccak256, parseEther, Transaction } from 'ethers';
import { buildPlan } from './plan.mjs';

const LOCAL_GAS = [5243607n, 2021718n, 584425n, 5260163n, 5255155n, 812653n, 1370175n, 4067728n];

async function save(path, state) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
}

async function load(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Resume only the same signed transactions; never replace an uncertain broadcast. */
export async function deployStack({ provider, signer, owner, path, expectedChainId, maxGasPrice, onSaved = () => {} }) {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(expectedChainId)) throw new Error(`Unexpected chain ${network.chainId}`);
    const sender = await signer.getAddress();
    const file = resolve(path);
    let state = await load(file);
    const pendingNonce = async () => Number(BigInt(await provider.send('eth_getTransactionCount', [sender, 'pending'])));
    const nonce = state?.startNonce ?? await pendingNonce();
    const plan = await buildPlan(sender, nonce, owner);

    if (!state) {
        const balance = await provider.getBalance(sender);
        const reserve = LOCAL_GAS.reduce((a, b) => a + b, 0n) * maxGasPrice * 125n / 100n;
        if (balance < reserve) throw new Error(`Insufficient deployment balance: need at least ${formatEther(reserve)} CYBER at the gas cap`);
        for (const step of plan.steps) if (await provider.getCode(step.address) !== '0x') throw new Error(`Address already occupied: ${step.name}`);
        state = { version: 1, chainId: String(network.chainId), sender, owner: plan.owner, startNonce: nonce, steps: plan.steps.map(({ name, address, nonce: n, initcodeHash }) => ({ name, address, nonce: n, initcodeHash, status: 'planned' })) };
        await save(file, state);
    }
    if (state.version !== 1 || state.chainId !== String(network.chainId) || state.sender.toLowerCase() !== sender.toLowerCase() || state.owner.toLowerCase() !== plan.owner.toLowerCase() || state.steps.length !== plan.steps.length) throw new Error('Checkpoint does not match this deployment');

    for (let i = 0; i < plan.steps.length; i++) {
        const planned = plan.steps[i];
        const saved = state.steps[i];
        if (saved.name !== planned.name || saved.address.toLowerCase() !== planned.address.toLowerCase() || saved.nonce !== planned.nonce || saved.initcodeHash !== planned.initcodeHash) throw new Error(`Checkpoint changed: ${planned.name}`);
        if (saved.status === 'confirmed') {
            const receipt = await provider.getTransactionReceipt(saved.hash);
            if (!receipt || receipt.status !== 1 || receipt.contractAddress?.toLowerCase() !== planned.address.toLowerCase() || await provider.getCode(planned.address) === '0x') throw new Error(`Confirmed deployment is unreadable or changed: ${planned.name}`);
            continue;
        }
        if (saved.status === 'planned') {
            if (await provider.getCode(planned.address) !== '0x') throw new Error(`Address already occupied: ${planned.name}`);
            if (await pendingNonce() !== planned.nonce) throw new Error(`Deployer nonce changed before ${planned.name}`);
            const fee = await provider.getFeeData();
            if (fee.gasPrice === null || fee.gasPrice > maxGasPrice) throw new Error(`Gas price unavailable or above cap before ${planned.name}`);
            const estimate = await provider.estimateGas({ from: sender, data: planned.data });
            const gasLimit = (estimate * 125n + 99n) / 100n;
            const block = await provider.getBlock('latest');
            if (!block || gasLimit > block.gasLimit) throw new Error(`Gas limit exceeds block limit for ${planned.name}`);
            if (await provider.getBalance(sender) < gasLimit * fee.gasPrice) throw new Error(`Insufficient gas balance for ${planned.name}`);
            const raw = await signer.signTransaction({ type: 0, chainId: network.chainId, nonce: planned.nonce, gasPrice: fee.gasPrice, gasLimit, data: planned.data, value: 0 });
            saved.raw = raw;
            saved.hash = keccak256(raw);
            saved.status = 'signed';
            await save(file, state);
            await onSaved(saved);
        }
        if (saved.status !== 'signed' || !saved.raw || keccak256(saved.raw) !== saved.hash) throw new Error(`Invalid signed checkpoint: ${planned.name}`);
        const signed = Transaction.from(saved.raw);
        if (signed.from?.toLowerCase() !== sender.toLowerCase() || signed.chainId !== network.chainId || signed.nonce !== planned.nonce || signed.to !== null || keccak256(signed.data) !== planned.initcodeHash || signed.value !== 0n) throw new Error(`Signed transaction does not match plan: ${planned.name}`);
        let receipt = await provider.getTransactionReceipt(saved.hash);
        if (!receipt) {
            try { await provider.broadcastTransaction(saved.raw); } catch { /* A lost response is resolved by the receipt, never a new transaction. */ }
            // This chain produces blocks only when there is work. Waiting on
            // another block event can stall after the transaction has already
            // mined, so poll the receipt itself and never replace the hash.
            const until = Date.now() + 120000;
            while (!receipt && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                receipt = await provider.getTransactionReceipt(saved.hash);
            }
        }
        if (!receipt) throw new Error(`Pending transaction ${saved.hash}; retry the same checkpoint`);
        if (receipt.status !== 1 || receipt.contractAddress?.toLowerCase() !== planned.address.toLowerCase() || await provider.getCode(planned.address) === '0x') throw new Error(`Deployment failed: ${planned.name}, transaction ${saved.hash}`);
        saved.status = 'confirmed';
        saved.blockNumber = receipt.blockNumber;
        saved.gasUsed = receipt.gasUsed.toString();
        delete saved.raw;
        await save(file, state);
        console.log(`${planned.name}: ${planned.address} (${saved.hash})`);
    }
    const manager = new Contract(plan.addresses.PoolManager, ['function owner() view returns (address)'], provider);
    if ((await manager.owner()).toLowerCase() !== plan.owner.toLowerCase()) throw new Error('PoolManager owner mismatch');
    return state;
}

async function main() {
    if (process.argv[2] !== '--broadcast') throw new Error('Requires --broadcast; use plan.mjs for read-only review');
    const key = process.env.DEPLOYER_PK;
    if (!key) throw new Error('DEPLOYER_PK is not set');
    const provider = new JsonRpcProvider('https://cyberia.church/api/fuji/rpc');
    const gasCap = parseEther('0.0003');
    await deployStack({ provider, signer: new Wallet(key, provider), owner: '0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393', path: '../hardhat/deployments/cyberia-v4-49407.json', expectedChainId: 49407, maxGasPrice: gasCap });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
