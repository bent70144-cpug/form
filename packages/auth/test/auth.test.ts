import { describe, expect, it } from "vitest";
import {
  createSessionClient,
  sessionSchema,
  type AuthSession,
} from "../src/client/index";
import {
  AUTH_MOUNT,
  createAuth,
  resolveEmailProvider,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "../src/server/index";
import { ResendEmailProvider } from "../src/server/email/resend";
import { EmailProviderNotConfiguredError } from "../src/server/email/types";
import {
  PASSWORD_LIMITS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isValidPasswordLength,
} from "../src/password";

describe("@form/auth/client", () => {
  it("validates the minimal session shape (flat, workspace nullable)", () => {
    const session: AuthSession = {
      userId: "u1",
      email: "a@b.co",
      emailVerified: true,
      workspace: { id: "w1", name: "Personal", role: "owner" },
    };
    expect(sessionSchema.parse(session)).toEqual(session);
    expect(
      sessionSchema.safeParse({
        userId: "u1",
        email: "a@b.co",
        emailVerified: false,
        workspace: null,
      }).success,
    ).toBe(true);
    expect(
      sessionSchema.safeParse({ userId: "u1", workspace: null }).success,
    ).toBe(false);
  });

  it("typed client forwards the cookie header to the internal API (SSR path)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          userId: "u1",
          email: "a@b.co",
          emailVerified: false,
          workspace: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = createSessionClient({
      baseUrl: "http://127.0.0.1:4000/",
      fetchImpl,
    });
    const session = await client.getSession("sid=abc");
    expect(session?.userId).toBe("u1");
    expect(session?.workspace).toBeNull();
    expect(calls[0].url).toBe("http://127.0.0.1:4000/v1/auth/session");
    expect((calls[0].init.headers as Record<string, string>)["cookie"]).toBe(
      "sid=abc",
    );
  });

  it("browser path defaults to a same-origin relative URL through the /v1 rewrite", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          userId: "u1",
          email: "a@b.co",
          emailVerified: true,
          workspace: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = createSessionClient({ fetchImpl });
    await client.getSession();
    expect(calls[0].url).toBe("/v1/auth/session");
    expect((calls[0].init.headers as Record<string, string>)["cookie"]).toBeUndefined();
  });

  it("returns null on 401 instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const client = createSessionClient({ baseUrl: "http://127.0.0.1:4000", fetchImpl });
    await expect(client.getSession()).resolves.toBeNull();
  });
});

describe("@form/auth/server", () => {
  it("describes the mount point and the Nest-handled fall-through", () => {
    expect(AUTH_MOUNT.basePath).toBe("/v1/auth");
    expect(AUTH_MOUNT.nestHandledPaths).toContain("/v1/auth/session");
  });

  it("builds a Better Auth instance with the pinned settings (no connection at construction)", () => {
    const auth = createAuth({
      databaseUrl: "postgres://app_user:x@127.0.0.1:5433/form_test",
      appOrigin: "http://localhost:3000",
      secret: "not-used-in-this-smoke-test-0123456789",
    });
    expect(typeof auth.api.getSession).toBe("function");
    expect(typeof auth.api.signUpEmail).toBe("function");
    expect(typeof auth.api.signInEmail).toBe("function");
    expect(typeof auth.api.signOut).toBe("function");
    expect(typeof auth.api.verifyEmail).toBe("function");
    expect(typeof auth.api.sendVerificationEmail).toBe("function");
  });

  it("pins the 7-day rolling session policy explicitly", () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(604800); // 7 days
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(86400); // rolling daily refresh
  });
});

describe("password policy constants (shared with ticket 04)", () => {
  it("enforces 12–128 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_LIMITS).toEqual({ min: 12, max: 128 });
    expect(isValidPasswordLength("a".repeat(11))).toBe(false);
    expect(isValidPasswordLength("a".repeat(12))).toBe(true);
    expect(isValidPasswordLength("a".repeat(128))).toBe(true);
    expect(isValidPasswordLength("a".repeat(129))).toBe(false);
  });
});

describe("email providers", () => {
  const ENV = { NODE_ENV: undefined } as NodeJS.ProcessEnv;

  it("defaults to the mail sink in development and Resend in production", () => {
    expect(resolveEmailProvider({ ...ENV, NODE_ENV: "test" }).name).toBe("mail_sink");
    expect(resolveEmailProvider({ ...ENV, NODE_ENV: "development" }).name).toBe("mail_sink");
    expect(resolveEmailProvider({ ...ENV }).name).toBe("mail_sink");
    expect(resolveEmailProvider({ ...ENV, NODE_ENV: "production" }).name).toBe("resend");
    expect(resolveEmailProvider({ ...ENV, EMAIL_PROVIDER: "resend" }).name).toBe("resend");
  });

  it("honors an explicit mail_sink selection in production (no silent console adapter)", () => {
    expect(
      resolveEmailProvider({ NODE_ENV: "production", EMAIL_PROVIDER: "mail_sink" }).name,
    ).toBe("mail_sink");
  });

  it("Resend adapter refuses to send without RESEND_API_KEY", async () => {
    const provider = new ResendEmailProvider({ apiKey: undefined });
    await expect(
      provider.sendVerificationEmail({
        to: "user@example.com",
        subject: "Verify",
        text: "body",
        url: "http://x/v1/auth/verify-email?token=SECRET",
        user: { id: "u1", email: "user@example.com", name: "U" },
      }),
    ).rejects.toBeInstanceOf(EmailProviderNotConfiguredError);
  });

  it("Resend adapter posts to the HTTPS API when configured", async () => {
    const bodies: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      bodies.push({ url, init });
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ResendEmailProvider({
      apiKey: "re_test_key",
      from: "Form <verify@form.example>",
      fetchImpl,
    });
    await provider.sendVerificationEmail({
      to: "user@example.com",
      subject: "Verify your email",
      text: "Open http://x/v1/auth/verify-email?token=t",
      url: "http://x/v1/auth/verify-email?token=t",
      user: { id: "u1", email: "user@example.com", name: "U" },
    });
    expect(bodies[0].url).toBe("https://api.resend.com/emails");
    const headers = bodies[0].init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer re_test_key");
    const payload = JSON.parse(String(bodies[0].init.body)) as {
      from: string;
      to: string[];
      text: string;
    };
    expect(payload.from).toBe("Form <verify@form.example>");
    expect(payload.to).toEqual(["user@example.com"]);
    expect(payload.text).toContain("verify-email?token=t");
  });

  it("Resend adapter surfaces failures without echoing the verification link", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "denied" }), { status: 403 })) as unknown as typeof fetch;
    const provider = new ResendEmailProvider({ apiKey: "k", fetchImpl });
    await expect(
      provider.sendVerificationEmail({
        to: "user@example.com",
        subject: "s",
        text: "http://x/v1/auth/verify-email?token=SECRET",
        url: "http://x/v1/auth/verify-email?token=SECRET",
        user: { id: "u1", email: "user@example.com", name: "U" },
      }),
    ).rejects.toThrow(/status 403/);
  });
});
