import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { EmailVerifier } from "./verifier/verifier.js";
import { createApi } from "./routes/api.js";
import { auth } from "./middleware/auth.js";
import { serverConfig, verifierConfig } from "./config.js";
import { error as logError, info } from "./lib/logger.js";

const verifier = new EmailVerifier(verifierConfig);
await verifier.init();

const app = new Hono();
app.use("*", auth(serverConfig.authToken));
app.route("/", createApi(verifier));

app.notFound((c) => c.json({ error: "Not found" }, 404));

serve(
  {
    fetch: app.fetch,
    port: serverConfig.port,
    hostname: serverConfig.host,
  },
  () => {
    info(`ProxMail listening on http://${serverConfig.host}:${serverConfig.port}`);
  },
);

process.on("unhandledRejection", (err) => {
  logError(`Unhandled rejection: ${(err as Error).message}`);
});
