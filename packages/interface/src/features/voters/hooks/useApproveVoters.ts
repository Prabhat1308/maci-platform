import { type Transaction } from "@ethereum-attestation-service/eas-sdk";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";

import { eas, config } from "~/config";
import { useRound } from "~/contexts/Round";
import { useAttest } from "~/hooks/useEAS";
import { useEthersSigner } from "~/hooks/useEthersSigner";
import { createAttestation } from "~/lib/eas/createAttestation";

// TODO: Move this to a shared folders
export interface TransactionError {
  reason?: string;
  data?: { message: string };
}

export function useApproveVoters(options: {
  onSuccess: () => void;
  onError: (err: TransactionError) => void;
}): UseMutationResult<Transaction<string[]>, unknown, string[]> {
  const attest = useAttest();
  const signer = useEthersSigner();
  const { rounds } = useRound();

  return useMutation({
    mutationFn: async (voters: string[]) => {
      if (!signer) {
        throw new Error("Connect wallet first");
      }

      // Prefer a stable round identifier for the "round" field. Use the first round's roundId if present.
      const roundId = rounds && rounds.length > 0 ? rounds[0]?.roundId : (config.roundOrganizer ?? "default");
      const attestations = await Promise.all(
        voters.map((recipient) =>
          createAttestation(
            {
              values: { type: "voter", round: roundId },
              schemaUID: eas.schemas.approval,
              recipient,
            },
            signer,
          ),
        ),
      );
      return attest.mutateAsync(attestations.map((att) => ({ ...att, data: [att.data] })));
    },
    ...options,
  });
}
