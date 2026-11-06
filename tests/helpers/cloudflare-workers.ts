/** Minimal stand-ins for `cloudflare:workers` so Worker modules can be unit-tested in Node. */
export class WorkerEntrypoint<E = unknown> {
  env: E;
  ctx: unknown;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class DurableObject<E = unknown> extends WorkerEntrypoint<E> {}
export const env = {};
