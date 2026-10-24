import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type { AppContext } from "../src/types.js";

const keys = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("jose", async (importOriginal) => {
  const jose = await importOriginal<typeof import("jose")>();
  return { ...jose, createRemoteJWKSet: () => keys.resolve };
});

const { requireAuth } = await import("../src/auth.js");
let privateKey: CryptoKey;
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Test";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicKey = await exportJWK(pair.publicKey);
  keys.resolve.mockImplementation(createLocalJWKSet({ keys: [{ ...publicKey, kid: "test", alg: "RS256" }] }));
});

afterEach(() => vi.unstubAllEnvs());

async function token(claims: JWTPayload = {}) {
  return new SignJWT({ token_use: "access", client_id: "browser", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setSubject("user-1")
    .setExpirationTime("5m")
    .sign(privateKey);
}

function app() {
  vi.stubEnv("COGNITO_USER_POOL", "us-east-1_Test");
  vi.stubEnv("COGNITO_CLIENT_ID", "browser");
  vi.stubEnv("SMOKE_CLIENT_ID", "smoke");
  const app = new Hono<AppContext>();
  app.use("/api/*", requireAuth);
  app.post("/api/chat", (c) => c.json({ user: c.get("userId") }));
  app.get("/api/history", (c) => c.json({ user: c.get("userId") }));
  app.get("/api/failure", () => { throw new Error("Application failure"); });
  return app;
}

describe("Cognito JWT middleware", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await app().request("/api/history")).status).toBe(401);
  });

  it("accepts signed user access tokens for the configured app", async () => {
    const response = await app().request("/api/history", {
      headers: { Authorization: `Bearer ${await token()}` }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "user-1" });
  });

  it("rejects a valid signature with the wrong app client", async () => {
    expect((await app().request("/api/history", {
      headers: { Authorization: `Bearer ${await token({ client_id: "other" })}` }
    })).status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const expired = await new SignJWT({ token_use: "access", client_id: "browser" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer).setSubject("user-1").setExpirationTime(1).sign(privateKey);
    expect((await app().request("/api/history", {
      headers: { Authorization: `Bearer ${expired}` }
    })).status).toBe(401);
  });

  it("restricts scoped smoke JWTs to the parse route and isolated data", async () => {
    const headers = { Authorization: `Bearer ${await token({ client_id: "smoke", scope: "diet-smoke/parse" })}` };
    const application = app();
    const response = await application.request("/api/chat", { method: "POST", headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "smoke:smoke" });
    expect((await application.request("/api/history", { headers })).status).toBe(403);
  });

  it("rejects smoke JWTs without their dedicated scope", async () => {
    expect((await app().request("/api/chat", {
      method: "POST", headers: { Authorization: `Bearer ${await token({ client_id: "smoke" })}` }
    })).status).toBe(401);
  });

  it("does not misreport downstream application errors as authentication errors", async () => {
    expect((await app().request("/api/failure", {
      headers: { Authorization: `Bearer ${await token()}` }
    })).status).toBe(500);
  });
});
