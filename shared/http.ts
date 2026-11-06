/** Small HTTP helpers shared by all GovZones workers. */

export type ErrorCode =
  | "WALLET_ENROLLMENT_REQUIRED"
  | "ALREADY_ENROLLED"
  | "INVALID_PROOF"
  | "UNAPPROVED_GROUP_ROOT"
  | "EXPIRED_CHALLENGE"
  | "REPLAYED_CHALLENGE"
  | "INVALID_SCORE"
  | "ENTITY_NOT_RATABLE"
  | "VOTE_COOLDOWN"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CREDENTIALS_NOT_ALLOWED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "CSRF_FAILED"
  | "TURNSTILE_FAILED"
  | "INVALID_EMAIL"
  | "INVALID_CODE"
  | "CODE_EXPIRED"
  | "EMAIL_DELIVERY_FAILED"
  | "ENROLLMENT_BLOCKED"
  | "PAYLOAD_TOO_LARGE"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  WALLET_ENROLLMENT_REQUIRED: 409,
  ALREADY_ENROLLED: 409,
  INVALID_PROOF: 400,
  UNAPPROVED_GROUP_ROOT: 400,
  EXPIRED_CHALLENGE: 400,
  REPLAYED_CHALLENGE: 409,
  INVALID_SCORE: 400,
  ENTITY_NOT_RATABLE: 400,
  VOTE_COOLDOWN: 429,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CREDENTIALS_NOT_ALLOWED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  TURNSTILE_FAILED: 403,
  INVALID_EMAIL: 400,
  INVALID_CODE: 400,
  CODE_EXPIRED: 400,
  EMAIL_DELIVERY_FAILED: 502,
  ENROLLMENT_BLOCKED: 403,
  PAYLOAD_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL: 500,
};

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  VOTE_COOLDOWN: "You can update this rating once every 30 days.",
  INVALID_SCORE: "Ratings must be a whole number from 1 to 10.",
  ENTITY_NOT_RATABLE: "This listing cannot be rated.",
  EXPIRED_CHALLENGE: "Your request expired. Please try again.",
  REPLAYED_CHALLENGE: "This request was already used. Please try again.",
  UNAPPROVED_GROUP_ROOT: "Your voting pass needs to refresh. Please try again.",
  RATE_LIMITED: "Too many requests. Please wait and try again.",
  INVALID_EMAIL: "Please enter a valid e-mail address.",
  INVALID_CODE: "That code is not correct. Check the e-mail and try again.",
  CODE_EXPIRED: "That code has expired or was already used. Request a new one.",
  EMAIL_DELIVERY_FAILED: "We could not send the e-mail right now. Please try again in a moment.",
};

export class HttpError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? MESSAGES[code] ?? code);
  }
  get status() {
    return STATUS[this.code];
  }
}

export const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), interest-cohort=()",
};

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

export function json(body: unknown, init: ResponseInit = {}, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  for (const [k, v] of Object.entries({ ...BASE_SECURITY_HEADERS, ...extraHeaders })) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(err: unknown, extraHeaders: Record<string, string> = {}): Response {
  if (err instanceof HttpError) {
    return json(
      { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } },
      { status: err.status },
      extraHeaders,
    );
  }
  // Never echo internal error details (could contain proof payloads or identifiers).
  console.error("internal_error", err instanceof Error ? err.name : "unknown");
  return json({ error: { code: "INTERNAL", message: "Something went wrong." } }, { status: 500 }, extraHeaders);
}

export async function readJson<T = unknown>(request: Request, maxBytes = 16_384): Promise<T> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError("BAD_REQUEST", "Expected JSON body.");
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError("BAD_REQUEST", "Malformed JSON.");
  }
}

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export function dayOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function corsHeaders(
  request: Request,
  allowedOrigins: string[],
  opts: { credentials: boolean; methods: string; headers: string },
): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins.includes(origin)) return { Vary: "Origin" };
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": opts.methods,
    "Access-Control-Allow-Headers": opts.headers,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (opts.credentials) h["Access-Control-Allow-Credentials"] = "true";
  return h;
}
