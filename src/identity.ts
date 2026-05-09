import { Wallet, getAddress, verifyTypedData } from "ethers";

import { RecordVersionRef } from "./state-package";

export interface MutationEnvelope {
  actor: string;
  nonce: string;
  issuedAt: string;
  summary: string;
  readSet: RecordVersionRef[];
  signature: string;
}

const verifyingContract = "0x0000000000000000000000000000000000000000";

const mutationTypes = {
  RecordVersion: [
    { name: "table", type: "string" },
    { name: "id", type: "string" },
    { name: "version", type: "uint256" }
  ],
  Mutation: [
    { name: "actor", type: "address" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
    { name: "summary", type: "string" },
    { name: "readSet", type: "RecordVersion[]" }
  ]
};

function domain(projectId: string) {
  return {
    name: "Kanboard",
    version: "1",
    chainId: 0,
    verifyingContract,
    salt: `0x${Buffer.from(projectId).subarray(0, 32).toString("hex").padEnd(64, "0")}`
  };
}

function normalizeActor(actor: string): string {
  return getAddress(actor);
}

function unsignedMutation(envelope: MutationEnvelope) {
  return {
    actor: normalizeActor(envelope.actor),
    nonce: envelope.nonce,
    issuedAt: envelope.issuedAt,
    summary: envelope.summary,
    readSet: envelope.readSet.map((ref) => ({
      table: ref.table,
      id: ref.id,
      version: ref.version
    }))
  };
}

export function deriveAddress(privateKey: string): string {
  return new Wallet(privateKey).address;
}

export async function signMutationEnvelope(
  privateKey: string,
  projectId: string,
  envelope: Omit<MutationEnvelope, "actor" | "signature">
): Promise<MutationEnvelope> {
  const wallet = new Wallet(privateKey);
  const unsigned = {
    actor: wallet.address,
    ...envelope,
    signature: "0x"
  };
  const signature = await wallet.signTypedData(domain(projectId), mutationTypes, unsignedMutation(unsigned));

  return {
    ...unsigned,
    signature
  };
}

export function verifyMutationEnvelope(projectId: string, envelope: MutationEnvelope): string {
  const recovered = verifyTypedData(domain(projectId), mutationTypes, unsignedMutation(envelope), envelope.signature);
  const actor = normalizeActor(envelope.actor);

  if (normalizeActor(recovered) !== actor) {
    throw new Error(`Mutation signature recovered ${recovered}, not actor ${actor}.`);
  }

  return actor;
}
