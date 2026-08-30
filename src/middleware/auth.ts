import type { MiddlewareHandler } from "hono";

/**
 * Optional shared-secret auth. All API routes are protected when AUTH_TOKEN is set.
 */
export function auth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      await next();
      return;
    }
    const provided = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== token) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
