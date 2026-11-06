import { useRouteLoaderData } from "react-router";

/** Public (non-secret) configuration serialized from the root loader. */
export interface PublicConfig {
  environment: "development" | "preview" | "staging" | "production";
  publicOrigin: string;
  accountsOrigin: string;
  voteOrigin: string;
  turnstileSiteKey: string;
  rootPublicKey: string;
}

export function useConfig(): PublicConfig {
  const data = useRouteLoaderData("root") as { config: PublicConfig } | undefined;
  if (!data) throw new Error("root config unavailable");
  return data.config;
}
