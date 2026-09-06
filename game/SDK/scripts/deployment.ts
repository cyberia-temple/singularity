import { AbiCoder, Contract, keccak256 } from "ethers";
import type { Provider } from "ethers";

export async function inspectDeployment(
  provider: Provider,
  transactionHash: string,
  bytecode: string,
  phaseDuration: bigint,
) {
  const chain = await provider.getNetwork();
  if (chain.chainId !== 49406n) throw new Error("Expected Cyberia chain 49406");
  const transaction = await provider.getTransaction(transactionHash);
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (
    !transaction ||
    !receipt ||
    receipt.status !== 1 ||
    !receipt.contractAddress
  )
    throw new Error("Expected a confirmed successful contract deployment");
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint64"],
    [phaseDuration],
  );
  if (
    transaction.to !== null ||
    transaction.data !== bytecode + encoded.slice(2)
  )
    throw new Error(
      "Deployment input does not match this build and constructor",
    );
  const code = await provider.getCode(receipt.contractAddress);
  if (code === "0x") throw new Error("Deployed runtime code is missing");
  const arena = new Contract(
    receipt.contractAddress,
    ["function phaseDuration() view returns (uint64)"],
    provider,
  );
  if ((await arena.phaseDuration()) !== phaseDuration)
    throw new Error("On-chain phase duration does not match constructor");
  return {
    contract: "RockPaperScissors",
    chainId: Number(chain.chainId),
    address: receipt.contractAddress,
    deployer: transaction.from,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    constructorArguments: [phaseDuration.toString()],
    creationBytecodeHash: keccak256(bytecode),
    runtimeBytecodeHash: keccak256(code),
  };
}
