import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { loadDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-bound.js";
import { getDeliveryQueueEntriesOwnersInDatabase } from "../delivery-queue-sqlite.kernel.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
} from "./delivery-queue-namespaces.js";

const OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS = [
  ...OUTBOUND_EXECUTABLE_QUEUE_NAMES.map((queueName) => [queueName, "prepared"] as const),
  [OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, "preparing"],
  [OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, "migration"],
  [OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, "legacy-preparing"],
  [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, "legacy"],
] as const;

/** Exact IDs share one custody owner across the executable outbound formats. */
export function resolveOutboundDeliveryQueueNameInDatabase(
  database: OpenClawStateDatabase,
  id: string,
): string {
  const owners = getDeliveryQueueEntriesOwnersInDatabase(
    database,
    OUTBOUND_EXECUTABLE_QUEUE_NAMES,
    [id],
  ).get(id);
  if (owners && owners.size > 1) {
    throw new Error(`Ambiguous outbound delivery custody: ${id}`);
  }
  return owners?.keys().next().value ?? OUTBOUND_DELIVERY_QUEUE_NAME;
}

/**
 * FORK: a preparation still in "claimed" state whose lease has expired never
 * started modifiers or transport, and the next claim reclaims it outright
 * (see claimPreparation). It is not live custody. Counting it as a pending
 * owner made restart recovery defer forever on released claims (lease 0),
 * which wedged the session and failed every inbound turn behind it.
 */
function isAbandonedPreparationClaim(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
  status: string,
): boolean {
  if (queueName !== OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME || status !== "pending") {
    return false;
  }
  const entry = loadDeliveryQueueEntryInDatabase(database, queueName, id, "pending") as {
    preparationState?: unknown;
    preparationLeaseExpiresAt?: unknown;
  } | null;
  if (!entry || entry.preparationState !== "claimed") {
    return false;
  }
  const lease =
    typeof entry.preparationLeaseExpiresAt === "number" ? entry.preparationLeaseExpiresAt : 0;
  return lease <= Date.now();
}

export function findDeliveryIntentOwnersInDatabase(
  database: OpenClawStateDatabase,
  params: { ids: readonly string[] },
) {
  const owners = getDeliveryQueueEntriesOwnersInDatabase(
    database,
    OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.map(([queueName]) => queueName),
    params.ids,
  );
  return params.ids.map((id) => {
    const namespaces = owners.get(id);
    if (
      OUTBOUND_EXECUTABLE_QUEUE_NAMES.filter((queueName) => namespaces?.has(queueName)).length > 1
    ) {
      throw new Error(`Ambiguous outbound delivery custody: ${id}`);
    }
    for (const [queueName, namespace] of OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS) {
      const owner = namespaces?.get(queueName);
      if (owner && isAbandonedPreparationClaim(database, queueName, id, owner.status)) {
        continue;
      }
      if (owner) {
        return { queueName, namespace, retired: namespace !== "prepared", ...owner };
      }
    }
    return null;
  });
}
