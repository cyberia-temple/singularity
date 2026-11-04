import { ContractFactory, JsonRpcProvider, ZeroAddress, ZeroHash, encodeBytes32String, getAddress, getCreateAddress, keccak256 } from 'ethers';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { permit2Artifact, wrappedCyberArtifact } from './compile.mjs';

const require = createRequire(import.meta.url);
const core = require('@uniswap/v4-core/out/PoolManager.sol/PoolManager.json');
const periphery = (name) => require(`@uniswap/v4-periphery/foundry-out/${name}.sol/${name}.json`);
const router = require('@uniswap/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json');
const bytecode = (a) => typeof a.bytecode === 'string' ? a.bytecode : a.bytecode.object;

/** Build unsigned initcode. Predicted addresses are valid only for this sender and nonce. */
export async function buildPlan(sender, nonce, owner) {
    sender = getAddress(sender);
    owner = getAddress(owner);
    if (sender === ZeroAddress || owner === ZeroAddress || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid sender, owner or nonce');
    const labels = ['PoolManager', 'Permit2', 'WCYBER', 'PositionDescriptor', 'PositionManager', 'StateView', 'V4Quoter', 'UniversalRouter'];
    const addresses = Object.fromEntries(labels.map((name, i) => [name, getCreateAddress({ from: sender, nonce: nonce + i })]));
    const spec = [
        [core, [owner]],
        [permit2Artifact(), []],
        [wrappedCyberArtifact(), []],
        [periphery('PositionDescriptor'), [addresses.PoolManager, addresses.WCYBER, encodeBytes32String('CYBER')]],
        [periphery('PositionManager'), [addresses.PoolManager, addresses.Permit2, 300000, addresses.PositionDescriptor, addresses.WCYBER]],
        [periphery('StateView'), [addresses.PoolManager]],
        [periphery('V4Quoter'), [addresses.PoolManager]],
        [router, [[addresses.Permit2, addresses.WCYBER, ZeroAddress, ZeroAddress, ZeroHash, ZeroHash, addresses.PoolManager, ZeroAddress, addresses.PositionManager, ZeroAddress]]],
    ];
    const steps = await Promise.all(spec.map(async ([artifact, args], i) => {
        const tx = await new ContractFactory(artifact.abi, bytecode(artifact)).getDeployTransaction(...args);
        return { name: labels[i], nonce: nonce + i, address: addresses[labels[i]], data: tx.data, initcodeHash: keccak256(tx.data) };
    }));
    return { sender, owner, nonce, addresses, steps };
}

// Read-only plan: this command never signs or broadcasts a transaction.
async function main() {
    const [rpcUrl, sender, owner] = process.argv.slice(2);
    if (!rpcUrl || !sender || !owner) throw new Error('Usage: node plan.mjs <rpc-url> <deployer-address> <pool-manager-owner>');
    const provider = new JsonRpcProvider(rpcUrl);
    const chain = await provider.getNetwork();
    if (chain.chainId !== 49407n) throw new Error(`Expected Cyberia Fuji 49407, got ${chain.chainId}`);
    const nonce = await provider.getTransactionCount(sender, 'pending');
    const plan = await buildPlan(sender, nonce, owner);
    const occupied = [];
    for (const step of plan.steps) if (await provider.getCode(step.address) !== '0x') occupied.push(step.name);
    if (occupied.length) throw new Error(`Predicted addresses already contain code: ${occupied.join(', ')}`);
    const gas = await provider.getFeeData();
    console.log(JSON.stringify({ chainId: 49407, sender: plan.sender, owner: plan.owner, nonce, balanceWei: (await provider.getBalance(sender)).toString(), gasPriceWei: gas.gasPrice?.toString() ?? null, steps: plan.steps.map(({ name, nonce, address, initcodeHash }) => ({ name, nonce, address, initcodeHash })) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
