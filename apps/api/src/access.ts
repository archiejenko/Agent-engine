import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export interface AccessConfig {
  /** e.g. https://ejtech.cloudflareaccess.com */
  teamDomain: string | undefined;
  /** The Access application's AUD tag. */
  policyAud: string | undefined;
  /** Override the key set (tests). Defaults to the team's public certs. */
  jwks?: JWTVerifyGetKey;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

/**
 * Cloudflare Access check, done inside the Worker as well as at the edge (defence in depth).
 * Fails closed: if Access isn't configured, every request is refused.
 */
export function requireAccess(config: AccessConfig): MiddlewareHandler {
  return async (c, next) => {
    const { teamDomain, policyAud } = config;
    if (!teamDomain || !policyAud) {
      return c.json({ error: "access_not_configured" }, 403);
    }
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return c.json({ error: "missing_access_token" }, 403);

    let jwks = config.jwks ?? jwksCache.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
      jwksCache.set(teamDomain, jwks);
    }
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: teamDomain, audience: policyAud });
      c.set("accessEmail" as never, (payload.email as string | undefined) ?? null);
    } catch {
      return c.json({ error: "invalid_access_token" }, 403);
    }
    await next();
  };
}
