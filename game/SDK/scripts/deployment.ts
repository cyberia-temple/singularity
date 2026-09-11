import { AbiCoder, Contract, getAddress, keccak256 } from "ethers";
import type { Provider } from "ethers";

export async function inspectDeployment(
  provider: Provider,
  transactionHash: string,
  bytecode: string,
  phaseDuration: bigint,
  treasury?: string,
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
    treasury ? ["address"] : ["uint64"],
    treasury ? [getAddress(treasury)] : [phaseDuration],
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
    [
      "function phaseDuration() view returns (uint64)",
      "function treasury() view returns (address)",
      "function rulesVersion() view returns (uint256)",
    ],
    provider,
  );
  if ((await arena.phaseDuration()) !== phaseDuration)
    throw new Error("On-chain phase duration does not match constructor");
  if (
    treasury &&
    (phaseDuration !== 600n ||
      (await arena.rulesVersion()) !== 2n ||
      getAddress(await arena.treasury()) !== getAddress(treasury))
  )
    throw new Error("On-chain asynchronous rules or treasury do not match");
  return {
    contract: treasury ? "RockPaperScissorsAsync" : "RockPaperScissors",
    chainId: Number(chain.chainId),
    address: receipt.contractAddress,
    deployer: transaction.from,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    constructorArguments: treasury
      ? [getAddress(treasury)]
      : [phaseDuration.toString()],
    ...(treasury
      ? { rulesVersion: 2, phaseDuration: 600, treasury: getAddress(treasury) }
      : {}),
    creationBytecodeHash: keccak256(bytecode),
    runtimeBytecodeHash: keccak256(code),
  };
}
