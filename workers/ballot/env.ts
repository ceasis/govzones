import type { GroupRoots } from "../groups/index";
import type { BallotCoordinator } from "./coordinator";

/**
 * Bindings of the Anonymous Ballot Worker. Deliberately has NO identity DB,
 * session store, sign-in secrets or account-enrollment audit bindings.
 */
export interface Env {
  VOTES_DB: D1Database;
  /** Read-only use: entity ratability checks against the public directory. */
  DIRECTORY: D1Database;
  GROUP_ROOTS: Service<GroupRoots>;
  AGGREGATE_QUEUE: Queue<AggregateEvent>;
  BALLOT_COORDINATOR: DurableObjectNamespace<BallotCoordinator>;
  CHALLENGE_LIMITER?: RateLimit;
  ROOT_PUBLIC_KEY: string;
  /** Comma-separated origins allowed to call this host (CORS, no credentials). */
  PUBLIC_ORIGINS: string;
  /** Country served by this vote shard. */
  COUNTRY_CODE: string;
  COOLDOWN_DAYS?: string;
  CHALLENGE_TTL_SECONDS?: string;
}

export interface AggregateEvent {
  eventId: string;
  country: string;
  entityId: string;
  reason: "ballot_write" | "moderation" | "maturation" | "rebuild";
}
