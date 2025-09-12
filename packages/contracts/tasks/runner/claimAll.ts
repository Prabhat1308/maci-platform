/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */
import { task, types } from "hardhat/config";
import { ContractStorage, Deployment } from "maci-contracts";
import fs from "fs";

import { genTreeProof } from "maci-crypto";

import { ethers, type BigNumberish } from "ethers";
import {
  type MACI,
  type Poll,
  type Tally,
  Poll__factory as PollFactory,
  Tally__factory as TallyFactory,
  SimpleRegistry__factory as SimpleRegistryFactory,
} from "../../typechain-types";
import { EContracts } from "../helpers/constants";

interface IClaimAllParams {
  poll: string;
  tallyFile: string;
  /** Optional: start index to (re)start claims */
  start?: number;
  /** Optional: end index (inclusive) */
  end?: number;
  /** Dry run (no transactions), prints which claims would be made */
  dry?: boolean;
}

type HexString = string;

interface TallyJson {
  isQuadratic: boolean;
  tallyAddress: HexString;
  results: {
    tally: string[]; // decimal strings
    salt: HexString; // 0x..
    commitment: HexString; // 0x..
  };
  totalSpentVoiceCredits: {
    spent: string; // decimal string
    salt: HexString;
    commitment: HexString;
  };
}

task("claimAll", "Claim funds for all recipients of a poll")
  .addParam("poll", "The poll id", undefined, types.string)
  .addParam("tallyFile", "Path to tally.json with results", undefined, types.string)
  .addOptionalParam("start", "Start index (inclusive)", undefined, types.int)
  .addOptionalParam("end", "End index (inclusive)", undefined, types.int)
  .addFlag("dry", "Dry-run only; compute and log without sending transactions")
  .setAction(async ({ poll, tallyFile, start, end, dry }: IClaimAllParams, hre) => {
    const deployment = Deployment.getInstance();
    deployment.setHre(hre);
    deployment.setContractNames(EContracts);

    const storage = ContractStorage.getInstance();
    const { network } = hre;

    const signer = await deployment.getDeployer();

    const maciAddress = storage.mustGetAddress(EContracts.MACI, network.name);
    const { MACI__factory: MACIFactory } = await import("../../typechain-types");

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

    // Minimal ABI to validate proofs and pause status via parent (maci-contracts) functions
    const tallyAddress = await tallyContract.getAddress();
    const validationAbi = [
      "function verifyTallyResult(uint256,uint256,uint256[][],uint256,uint8,uint256,uint256) view returns (bool)",
      "function paused() view returns (bool)",
    ];
    const tallyValidation = new ethers.Contract(tallyAddress, validationAbi, signer);

    // Load tally.json
    if (!fs.existsSync(tallyFile)) {
      throw new Error(`Tally file not found: ${tallyFile}`);
    }
    const tallyJson = JSON.parse(await fs.promises.readFile(tallyFile, "utf8")) as TallyJson;

    if (tallyJson.isQuadratic) {
      throw new Error("claimAll: QV rounds are not supported by this task yet");
    }

    // Determine vote option tree depth and recipient range
    const voteOptionTreeDepth = Number((await pollContract.treeDepths())[3]);
    const registryAddress = await pollContract.getRegistry();
    const registry = SimpleRegistryFactory.connect(registryAddress, signer);
    const recipientCountBn = await registry.recipientCount();
    const recipientCount = Number(recipientCountBn);

    // Budget sanity check: budget must be >= totalSpent * voiceCreditFactor
    const [voiceCreditFactor, totalSpent, totalAmount] = await Promise.all([
      tallyContract.voiceCreditFactor(),
      tallyContract.totalSpent(),
      tallyContract.totalAmount(),
    ]);

    const contributions = voiceCreditFactor * totalSpent;
    if (totalAmount < contributions) {
      console.error(
        `Insufficient budget: totalAmount=${totalAmount.toString()} < contributions=${contributions.toString()} (voiceCreditFactor=${voiceCreditFactor.toString()} * totalSpent=${totalSpent.toString()}). Deposit at least ${(
          contributions - totalAmount
        ).toString()} more tokens or redeploy with correct maxContribution for token decimals.`,
      );
      return;
    }

    const leaves = tallyJson.results.tally.map((x) => BigInt(x));

    const first = start !== undefined ? Math.max(0, start) : 0;
    const last = end !== undefined ? Math.min(recipientCount - 1, end) : recipientCount - 1;

    if (first > last) {
      console.log(`Nothing to claim: start ${first} > end ${last}`);
      return;
    }

    console.log(`Claiming for indices [${first}..${last}] out of ${recipientCount} recipients`);

    const spentVoiceCreditsHash: BigNumberish = tallyJson.totalSpentVoiceCredits.commitment;
    const tallyResultSalt: BigNumberish = tallyJson.results.salt;
    const perVOSpentVoiceCreditsHash: BigNumberish = 0; // Non-QV

    // Iterate recipients
    for (let index = first; index <= last; index += 1) {
      // Skip if there is no leaf for this index
      if (index >= leaves.length) {
        console.log(`Skipping index ${index}: no tally result`);
        continue;
      }

      const tallyResultProof = genTreeProof(index, leaves, voteOptionTreeDepth);

      // Validate proof against on-chain commitment before sending tx
      const tallyResult = leaves[index];
      const isValid = await tallyValidation
        .verifyTallyResult(
          index,
          tallyResult,
          tallyResultProof,
          tallyResultSalt,
          voteOptionTreeDepth,
          spentVoiceCreditsHash,
          perVOSpentVoiceCreditsHash,
        )
        .catch(() => false);
      if (!isValid) {
        console.warn(`Index ${index}: proof mismatch with on-chain commitment, skipping`);
        continue;
      }

      // For non-QV, use the raw votes at this index as voiceCreditsPerOption
      const voiceCreditsPerOption = BigInt(tallyJson.results.tally[index] ?? "0");

      // Optionally skip zero allocations to save gas
      const amount = await tallyContract.getAllocatedAmount(index, voiceCreditsPerOption);
      if (amount === 0n) {
        console.log(`Index ${index}: allocation is 0, skipping`);
        continue;
      }

      const params = {
        index,
        voiceCreditsPerOption,
        tallyResultProof,
        tallyResultSalt,
        voteOptionTreeDepth,
        spentVoiceCreditsHash,
        perVOSpentVoiceCreditsHash,
      } as const;

      if (dry) {
        console.log(`DRY index ${index}: will claim amount=${amount.toString()}`);
        continue;
      }

      try {
        // Ensure not paused
        const isPaused: boolean = await tallyValidation.paused();
        if (isPaused) {
          console.error("Tally is paused. Unpause before claiming.");
          return;
        }
        const tx = await tallyContract.claim(params);
        const receipt = await tx.wait();
        console.log(`Claimed index ${index}: tx=${receipt?.hash ?? "unknown"} amount=${amount.toString()}`);
      } catch (err: unknown) {
        console.error(`Failed to claim index ${index}:`, err);
      }
    }
  });
