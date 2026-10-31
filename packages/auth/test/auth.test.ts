import { describe, expect, it } from "vitest";
import {
  createSessionClient,
  sessionSchema,
  type AuthSession,
} from "../src/client/index";
import {
  AUTH_MOUNT,
  AuthNotImplementedError,
  createAuthHandler,
} from "../src/server/index";

describe("@form/auth/client", () => {
  it("validates the minimal session shape", () => {
    const session: AuthSession = {
      user: { id: "u1", email: "a@b.co", emailVerified: true },
      workspace: { id: "w1", name: "Personal", role: "owner" },
    };
    expect(sessionSchema.parse(session)).toEqual(session);
    expect(
      sessionSchema.safeParse({ user: { id: "u1" }, workspace: null }).success,
    ).toBe(false);
  });

  it("typed client forwards the cookie header to the internal API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          user: { id: "u1", email: "a@b.co", emailVerified: false },
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
    expect(session?.user.id).toBe("u1");
    expect(session?.workspace).toBeNull();
    expect(calls).toHaveLength(1);
    const firstCall = calls[0]!;
    expect(firstCall.url).toBe("http://127.0.0.1:4000/v1/auth/session");
    expect((firstCall.init.headers as Record<string, string>)["cookie"]).toBe(
      "sid=abc",
    );
  });

  it("returns null on 401 instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const client = createSessionClient({
      baseUrl: "http://127.0.0.1:4000",
      fetchImpl,
    });
    await expect(client.getSession()).resolves.toBeNull();
  });
});

describe("@form/auth/server (stub boundary)", () => {
  it("describes the mount point used by the API", () => {
    expect(AUTH_MOUNT.basePath).toBe("/v1/auth");
  });

  it("refuses to serve until Better Auth is wired", async () => {
    const handler = createAuthHandler();
    await expect(
      handler(
        { headers: { get: () => null } },
        { status: () => ({ body: () => undefined }), body: () => undefined } as never,
      ),
    ).rejects.toBeInstanceOf(AuthNotImplementedError);
  });
});
