/* eslint-disable no-console */
import { task, types } from "hardhat/config";
import { ContractStorage, Deployment } from "maci-contracts";
import fs from "fs";
import { genTreeProof } from "maci-crypto";
import { ethers } from "ethers";

import {
  type MACI,
  type Poll,
  type Tally,
  Poll__factory as PollFactory,
  Tally__factory as TallyFactory,
} from "../../typechain-types";
import { EContracts } from "../helpers/constants";

interface IClaimOneParams {
  poll: string;
  tallyFile: string;
  index: number;
  dry?: boolean;
}

type HexString = string;

interface TallyJson {
  isQuadratic: boolean;
  tallyAddress: HexString;
  results: {
    tally: string[];
    salt: HexString;
    commitment: HexString;
  };
  totalSpentVoiceCredits: {
    spent: string;
    salt: HexString;
    commitment: HexString;
  };
  // Optional for QV
  perVOSpentVoiceCredits?: {
    tally: string[];
    salt: HexString;
    commitment: HexString;
  };
}

task("claimOne", "Claim funds for a single recipient index")
  .addParam("poll", "The poll id", undefined, types.string)
  .addParam("tallyFile", "Path to tally.json with results", undefined, types.string)
  .addParam("index", "Recipient index to claim", undefined, types.int)
  .addFlag("dry", "Dry-run only; compute and log without sending transactions")
  .setAction(async ({ poll, tallyFile, index, dry }: IClaimOneParams, hre) => {
    const deployment = Deployment.getInstance();
    deployment.setHre(hre);
    deployment.setContractNames(EContracts);

    if (!fs.existsSync(tallyFile)) {
      throw new Error(`Tally file not found: ${tallyFile}`);
    }
    const tallyJson = JSON.parse(await fs.promises.readFile(tallyFile, "utf8")) as TallyJson;

    const isQV = Boolean(tallyJson.isQuadratic);

    const storage = ContractStorage.getInstance();
    const { MACI__factory: MACIFactory } = await import("../../typechain-types");
    const maciAddress = storage.mustGetAddress(EContracts.MACI, hre.network.name);
    const maci = await deployment.getContract<MACI>({
      name: EContracts.MACI,
      address: maciAddress,
      abi: MACIFactory.abi,
    });

    const pollContracts = await maci.polls(poll);
    const pollContract = await deployment.getContract<Poll>({
      name: EContracts.Poll,
      address: pollContracts.poll,
      abi: PollFactory.abi,
    });
    const tallyContract = await deployment.getContract<Tally>({
      name: EContracts.Tally,
      address: pollContracts.tally,
      abi: TallyFactory.abi,
    });
    const tallyAddress = await tallyContract.getAddress();

    const voteOptionTreeDepth = Number((await pollContract.treeDepths())[3]);
    const leaves = tallyJson.results.tally.map((x) => BigInt(x));

    if (index < 0 || index >= leaves.length) {
      throw new Error(`Index ${index} out of bounds for results length ${leaves.length}`);
    }

    // Validate against on-chain commitment before claiming
    const iface = [
      "function verifyTallyResult(uint256,uint256,uint256[][],uint256,uint8,uint256,uint256) view returns (bool)",
      "function paused() view returns (bool)",
      "function claimed(uint256) view returns (bool)",
      "function getAllocatedAmount(uint256,uint256) view returns (uint256)",
      "function verifyPerVOSpentVoiceCredits(uint256,uint256,uint256[][],uint256,uint8,uint256,uint256) view returns (bool)",
    ];
    const validator = new ethers.Contract(tallyAddress, iface, await deployment.getDeployer());

    const tallyResultProof = genTreeProof(index, leaves, voteOptionTreeDepth);
    const localTallyResult = leaves[index];
    // Read on-chain stored tally result (this is what claim() uses internally)
    let onchainTallyResult: bigint = localTallyResult;
    try {
      const res = await (
        tallyContract as unknown as { tallyResults: (i: number) => Promise<{ value: bigint }> }
      ).tallyResults(index);
      onchainTallyResult = (res as unknown as { value: bigint }).value ?? localTallyResult;
    } catch {
      // Fallback to local if ABI mismatch
      onchainTallyResult = localTallyResult;
    }
    const perVOSpentHash = isQV ? (tallyJson.perVOSpentVoiceCredits?.commitment ?? 0) : 0;
    const isValid = await validator
      .verifyTallyResult(
        index,
        onchainTallyResult,
        tallyResultProof,
        tallyJson.results.salt,
        voteOptionTreeDepth,
        tallyJson.totalSpentVoiceCredits.commitment,
        perVOSpentHash,
      )
      .catch(() => false);
    if (!isValid) {
      console.error(
        `Proof mismatch for index ${index}. onchainTallyResult=${onchainTallyResult.toString()} localTallyResult=${localTallyResult.toString()} resultSalt=${tallyJson.results.salt} spentHash=${tallyJson.totalSpentVoiceCredits.commitment} perVOSpentHash=${perVOSpentHash}`,
      );
      throw new Error(`Proof mismatch for index ${index} against on-chain commitment at ${tallyAddress}`);
    }

    const isPaused: boolean = await validator.paused();
    if (isPaused) {
      throw new Error("Tally is paused; unpause before claiming");
    }

    const alreadyClaimed: boolean = await validator.claimed(index);
    if (alreadyClaimed) {
      console.log(`Index ${index} already claimed. Skipping.`);
      return;
    }

    // voiceCreditsPerOption
    const voiceCreditsPerOption = isQV
      ? BigInt(tallyJson.perVOSpentVoiceCredits?.tally?.[index] ?? "0")
      : leaves[index];
    const amount = await validator.getAllocatedAmount(index, voiceCreditsPerOption);
    // Finance diagnostics
    const [tokenAddr, totalAmount, totalSpent, voiceCreditFactor] = await Promise.all([
      tallyContract.token(),
      tallyContract.totalAmount(),
      tallyContract.totalSpent(),
      tallyContract.voiceCreditFactor(),
    ]);
    const contributions = voiceCreditFactor * totalSpent;
    const missing = totalAmount > contributions ? 0n : contributions - totalAmount;
    // Tally status diagnostics
    const [isTalliedFlag, batchNum, totalResults, recipients, alpha, totalVotesSquares] = await Promise.all([
      tallyContract.isTallied(),
      tallyContract.tallyBatchNum(),
      tallyContract.totalTallyResults(),
      tallyContract.recipientCount(),
      tallyContract.alpha(),
      tallyContract.totalVotesSquares(),
    ]);
    // For QV, verify per-VO spent proof root consistency if possible
    let perVoOk: boolean | undefined = undefined;
    if (isQV && tallyJson.perVOSpentVoiceCredits) {
      try {
        const perVoProof = genTreeProof(
          index,
          tallyJson.perVOSpentVoiceCredits.tally.map((x) => BigInt(x)),
          voteOptionTreeDepth,
        );
        perVoOk = await validator
          .verifyPerVOSpentVoiceCredits(
            index,
            BigInt(tallyJson.perVOSpentVoiceCredits.tally[index] ?? "0"),
            perVoProof,
            tallyJson.perVOSpentVoiceCredits.salt,
            voteOptionTreeDepth,
            tallyJson.totalSpentVoiceCredits.commitment,
            tallyJson.results.commitment,
          )
          .catch(() => false);
      } catch {
        perVoOk = false;
      }
    }
    console.log(
      `Diagnostics: token=${tokenAddr} totalAmount=${totalAmount.toString()} totalSpent=${totalSpent.toString()} voiceCreditFactor=${voiceCreditFactor.toString()} contributions=${contributions.toString()} missing=${missing.toString()} index=${index} amount=${amount.toString()} isQV=${isQV} isTallied=${isTalliedFlag} tallyBatchNum=${batchNum.toString()} totalTallyResults=${totalResults.toString()} recipientCount=${recipients.toString()} alpha=${alpha.toString()} totalVotesSquares=${totalVotesSquares.toString()} perVOProofOk=${perVoOk}`,
    );
    if (amount === 0n) {
      console.log(`Index ${index} has zero allocation. Nothing to claim.`);
      return;
    }

    const params = {
      index,
      voiceCreditsPerOption,
      tallyResultProof,
      tallyResultSalt: tallyJson.results.salt,
      voteOptionTreeDepth,
      spentVoiceCreditsHash: tallyJson.totalSpentVoiceCredits.commitment,
      perVOSpentVoiceCreditsHash: perVOSpentHash,
    } as const;

    if (dry) {
      console.log(`DRY index ${index}: amount=${amount.toString()} will be claimed to the project payout address`);
      return;
    }

    // Try a static call first to surface revert reasons
    try {
      await (tallyContract as unknown as { claim: { staticCall: (p: unknown) => Promise<void> } }).claim.staticCall(
        params,
      );
    } catch (e: any) {
      console.error("Static simulation reverted. Decoding error...");
      try {
        const { Tally__factory: TF } = await import("../../typechain-types");
        const iFace = TF.createInterface();
        const parsed = (
          iFace as unknown as { parseError: (data: string) => { name: string; args: any[] } | null }
        ).parseError(e?.data ?? e?.error?.data ?? e?.error?.data?.data ?? "0x");
        if (parsed) {
          console.error(`Revert reason: ${parsed.name} args=${JSON.stringify(parsed.args)}`);
        } else {
          console.error("Could not parse revert data", e);
        }
      } catch (pe) {
        console.error("Error while parsing revert data", pe);
      }
      console.error(
        `Budget check: totalAmount(${totalAmount.toString()}) vs contributions(${contributions.toString()}) -> missing=${missing.toString()}`,
      );
      throw e;
    }

    const tx = await tallyContract.claim(params);
    const receipt = await tx.wait();
    console.log(`Claimed index ${index}: tx=${receipt?.hash ?? "unknown"} amount=${amount.toString()}`);
  });
