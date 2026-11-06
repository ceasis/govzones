import { importVerifyKey, verifySignedRoot, type RootRecord } from "../../shared/signing";
import type { Env } from "./env";

interface CachedRoots {
  at: number;
  country: string;
  roots: RootRecord[];
}

let cache: CachedRoots | null = null;
let verifyKey: { jwk: string; key: CryptoKey } | null = null;
const CACHE_MS = 30_000;

/**
 * Currently accepted group roots, independently signature-checked.
 * Never trusts a root merely because a client proof references it.
 */
export async function acceptedRoots(env: Env, country: string, now = Date.now(), force = false): Promise<RootRecord[]> {
  if (!force && cache && cache.country === country && now - cache.at < CACHE_MS) {
    return cache.roots.filter((r) => Date.parse(r.validUntil) > now);
  }
  if (!verifyKey || verifyKey.jwk !== env.ROOT_PUBLIC_KEY) {
    verifyKey = { jwk: env.ROOT_PUBLIC_KEY, key: await importVerifyKey(env.ROOT_PUBLIC_KEY) };
  }
  const signed = await env.GROUP_ROOTS.accepted(country);
  const roots: RootRecord[] = [];
  for (const s of signed) {
    if (s.record.country !== country) continue;
    if (await verifySignedRoot(s, verifyKey.key)) roots.push(s.record);
  }
  cache = { at: now, country, roots };
  return roots.filter((r) => Date.parse(r.validUntil) > now);
}

/** Picks the accepted root a proof claims; prefers the countable group if both share a root. */
export function findRoot(roots: RootRecord[], merkleTreeRoot: string): RootRecord | null {
  const matches = roots.filter((r) => r.root === merkleTreeRoot);
  if (matches.length === 0) return null;
  return matches.find((r) => r.group === "countable") ?? matches[0];
}

/**
 * Resolves the root a proof claims. On a cache miss, refreshes once (at most every 2 s) so a
 * freshly published epoch is not rejected merely because this isolate's cache is stale.
 */
export async function resolveRoot(env: Env, country: string, merkleTreeRoot: string): Promise<RootRecord | null> {
  const hit = findRoot(await acceptedRoots(env, country), merkleTreeRoot);
  if (hit) return hit;
  if (cache && Date.now() - cache.at < 2_000) return null;
  return findRoot(await acceptedRoots(env, country, Date.now(), true), merkleTreeRoot);
}

export function resetRootCache() {
  cache = null;
}
