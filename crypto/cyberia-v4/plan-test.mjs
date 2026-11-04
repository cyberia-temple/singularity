import { network } from 'hardhat';
import { BrowserProvider } from 'ethers';
import { buildPlan } from './plan.mjs';

const connection = await network.create({ network: 'simulated' });
const provider = new BrowserProvider(connection.provider);
const signer = await provider.getSigner();
const sender = await signer.getAddress();
const plan = await buildPlan(sender, await provider.getTransactionCount(sender, 'pending'), sender);
for (const step of plan.steps) {
    const tx = await signer.sendTransaction({ data: step.data, nonce: step.nonce });
    const receipt = await tx.wait();
    if (receipt.contractAddress.toLowerCase() !== step.address.toLowerCase() || receipt.status !== 1) throw new Error(`Unexpected deployment: ${step.name}`);
    console.log(step.name, step.address, 'gas', receipt.gasUsed.toString());
}
