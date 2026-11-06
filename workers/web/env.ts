/** Bindings of the public web Worker (govzones.com). No identity or votes DB bindings. */
export interface WebEnv {
  DIRECTORY: D1Database;
  PUBLIC_CACHE: KVNamespace;
  GROUPS_PUBLIC: Fetcher;
  ENVIRONMENT: "development" | "preview" | "staging" | "production";
  PUBLIC_ORIGIN: string;
  ACCOUNTS_ORIGIN: string;
  VOTE_ORIGIN: string;
  TURNSTILE_SITE_KEY?: string;
  /** Group-root verification key, pinned into the client so roots are checked before use. */
  ROOT_PUBLIC_KEY: string;
  /** Development only: routes *.govzones.localhost hosts to the other Workers. */
  DEV_GATEWAY?: string;
  DEV_ACCOUNTS?: Fetcher;
  DEV_BALLOT?: Fetcher;
  DEV_ADMIN?: Fetcher;
  DEV_ACCOUNTS_ADMIN?: { runTrustScreening(): Promise<unknown> };
  DEV_GROUP_OPS?: { publishNow(): Promise<unknown> };
  DEV_AGGREGATOR?: {
    tick(force?: boolean): Promise<unknown>;
    rebuildAll(): Promise<unknown>;
    devAge(hours: number, opts?: { lastScored?: boolean }): Promise<unknown>;
    devEntityBallots(entityId: string): Promise<unknown>;
    devSeedDemo(entities?: number): Promise<unknown>;
    devClearDemo(): Promise<unknown>;
  };
}
