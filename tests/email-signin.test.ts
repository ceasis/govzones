import { describe, expect, it } from "vitest";
import { FakeD1 } from "./helpers/d1";
import { normalizeEmail, startEmailSignIn, verifyEmailSignIn } from "../workers/accounts/email";

const env = { SUBJECT_PEPPER: "pepper", DEV_EMAIL_CODES: "1" };
const req = () => new Request("https://accounts.test/api/v1/auth/email/start", { headers: { "CF-Connecting-IP": "203.0.113.5" } });

describe("e-mail sign-in", () => {
  it("normalises addresses so one mailbox is one account", () => {
    expect(normalizeEmail("  Juan.Dela.Cruz+gz@GMail.com ")).toBe("juandelacruz@gmail.com");
    expect(normalizeEmail("juan.dela.cruz@googlemail.com")).toBe("juandelacruz@gmail.com");
    expect(normalizeEmail("Maria+tag@Example.PH")).toBe("maria@example.ph");
    expect(normalizeEmail("maria.santos@example.ph")).toBe("maria.santos@example.ph");
    for (const bad of ["", "nope", "a@b", "a@b.c", "@x.com", 42, null]) expect(normalizeEmail(bad)).toBeNull();
  });

  it("issues a one-time code, limits attempts and never stores the address", async () => {
    const db = new FakeD1("identity");
    const { devCode } = await startEmailSignIn(env, db as never, req(), "Juan+one@gmail.com");
    expect(devCode).toMatch(/^\d{6}$/);
    const dump = JSON.stringify((await db.prepare(`SELECT * FROM email_sign_in_codes`).all()).results);
    expect(dump).not.toContain("gmail");
    expect(dump).not.toContain(devCode);
    // Wrong code counts an attempt; the right code (typed differently) signs in once only.
    await expect(verifyEmailSignIn(env, db as never, "juan@gmail.com", "000000")).rejects.toMatchObject({ code: "INVALID_CODE" });
    const subject = await verifyEmailSignIn(env, db as never, "j.u.a.n@gmail.com", `${devCode!.slice(0, 3)} ${devCode!.slice(3)}`);
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyEmailSignIn(env, db as never, "juan@gmail.com", devCode)).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("locks a code after five wrong guesses and replaces it when a new one is requested", async () => {
    const db = new FakeD1("identity");
    const first = (await startEmailSignIn(env, db as never, req(), "x@example.ph")).devCode!;
    for (let i = 0; i < 5; i++) await expect(verifyEmailSignIn(env, db as never, "x@example.ph", "999999")).rejects.toBeTruthy();
    await expect(verifyEmailSignIn(env, db as never, "x@example.ph", first)).rejects.toMatchObject({ code: "CODE_EXPIRED" });
    const second = (await startEmailSignIn(env, db as never, req(), "x@example.ph")).devCode!;
    expect(second).not.toBe(first);
    // Only the newest code is live: the old one is now simply a wrong code for the new row.
    await expect(verifyEmailSignIn(env, db as never, "x@example.ph", first)).rejects.toMatchObject({ code: "INVALID_CODE" });
    await expect(verifyEmailSignIn(env, db as never, "x@example.ph", second)).resolves.toBeTruthy();
  });

  it("rate-limits code requests per address", async () => {
    const db = new FakeD1("identity");
    for (let i = 0; i < 4; i++) await startEmailSignIn(env, db as never, req(), "y@example.ph");
    await expect(startEmailSignIn(env, db as never, req(), "y@example.ph")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
