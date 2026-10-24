import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";
import type { AppContext } from "./types.js";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function poolIssuer(pool: string): string {
  if (pool.startsWith("https://")) return pool.replace(/\/$/, "");
  const match = /^([a-z0-9-]+)_[A-Za-z0-9]+$/.exec(pool);
  if (!match?.[1]) throw new Error("COGNITO_USER_POOL must be a User Pool ID or issuer URL");
  return `https://cognito-idp.${match[1]}.amazonaws.com/${pool}`;
}

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

export async function verifyCognitoToken(token: string, pool = process.env.COGNITO_USER_POOL): Promise<JWTPayload & { sub: string }> {
  if (!pool) throw new Error("COGNITO_USER_POOL is not configured");
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!clientId) throw new Error("COGNITO_CLIENT_ID is not configured");
  const issuer = poolIssuer(pool);
  const { payload } = await jwtVerify(token, jwksFor(issuer), {
    issuer,
    algorithms: ["RS256"]
  });
  if (payload.token_use !== "access" && payload.token_use !== "id") {
    throw new errors.JWTClaimValidationFailed("Unexpected Cognito token type", payload, "token_use", "invalid");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new errors.JWTClaimValidationFailed("Cognito token is missing a subject", payload, "sub", "missing");
  }
  const smokeClientId = process.env.SMOKE_CLIENT_ID;
  const smokeClient = smokeClientId && payload.token_use === "access" && payload.client_id === smokeClientId;
  if (smokeClient && (typeof payload.scope !== "string" || !payload.scope.split(" ").includes("diet-smoke/parse"))) {
    throw new errors.JWTClaimValidationFailed("Smoke token is missing its required scope", payload, "scope", "missing");
  }
  if ((payload.token_use === "id" && payload.aud !== clientId) ||
      (payload.token_use === "access" && payload.client_id !== clientId && !smokeClient)) {
    throw new errors.JWTClaimValidationFailed("Cognito token was issued to a different app client", payload, "client_id", "invalid");
  }
  return { ...payload, sub: payload.sub };
}

export async function requireAuth(c: Context<AppContext>, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization");
  const match = header && /^Bearer ([^\s]+)$/.exec(header);
  if (!match?.[1]) return c.json({ error: "Authentication required" }, 401);
  if (!process.env.COGNITO_USER_POOL || !process.env.COGNITO_CLIENT_ID) {
    return c.json({ error: "Authentication is not configured" }, 503);
  }
  let payload: JWTPayload & { sub: string };
  try {
    payload = await verifyCognitoToken(match[1]);
  } catch (error) {
    console.warn("Authentication failed", error instanceof Error ? error.message : error);
    if (!(error instanceof errors.JOSEError)) return c.json({ error: "Authentication service unavailable" }, 503);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  if (process.env.SMOKE_CLIENT_ID && payload.client_id === process.env.SMOKE_CLIENT_ID) {
    if (c.req.method !== "POST" || c.req.path !== "/api/chat") return c.json({ error: "Forbidden" }, 403);
    c.set("userId", `smoke:${process.env.SMOKE_CLIENT_ID}`);
  } else {
    c.set("userId", payload.sub);
  }
  await next();
}
