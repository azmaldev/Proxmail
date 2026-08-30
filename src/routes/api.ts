import { Hono } from "hono";
import type { EmailVerifier } from "../verifier/verifier.js";

export function createApi(verifier: EmailVerifier): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/verify_single", async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = body?.email as string | undefined;

    if (!email || typeof email !== "string") {
      return c.json({ error: "Missing 'email' in request payload." }, 400);
    }

    try {
      const result = await verifier.verifySingleEmail(email);
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Internal server error: ${(err as Error).message}` }, 500);
    }
  });

  app.post("/batch", async (c) => {
    const body = await c.req.json().catch(() => null);
    const emails = body?.emails as string[] | undefined;

    if (!Array.isArray(emails) || emails.length === 0) {
      return c.json({ error: "Missing non-empty 'emails' array in request payload." }, 400);
    }
    if (emails.length > 1000) {
      return c.json({ error: "Batch limited to 1000 emails per request." }, 400);
    }
    if (emails.some((e) => typeof e !== "string")) {
      return c.json({ error: "All entries must be strings." }, 400);
    }

    try {
      const results = await verifier.verifyMany(emails);
      return c.json({ total: results.length, results });
    } catch (err) {
      return c.json({ error: `Internal server error: ${(err as Error).message}` }, 500);
    }
  });

  return app;
}
