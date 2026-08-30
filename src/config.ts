import { config as loadEnv } from "dotenv";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { VerifierConfig } from "./types/result.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const serverConfig = {
  port: int(process.env.PORT, 8080),
  host: process.env.HOST || "0.0.0.0",
  authToken: process.env.AUTH_TOKEN || "",
};

export const verifierConfig: VerifierConfig = {
  timeoutMs: int(process.env.TIMEOUT_MS, 15000),
  smtpTimeoutMs: int(process.env.SMTP_TIMEOUT_MS, 10000),
  dnsTimeoutMs: int(process.env.DNS_TIMEOUT_MS, 5000),
  catchallTestEnabled: bool(process.env.CATCHALL_TEST, true),
  checkDisposableEnabled: bool(process.env.CHECK_DISPOSABLE, true),
  rateLimitDelayMs: int(process.env.RATE_LIMIT_DELAY_MS, 2000),
  maxConcurrentDomains: int(process.env.MAX_CONCURRENT_DOMAINS, 5),
  maxConcurrentPerDomain: int(process.env.MAX_CONCURRENT_PER_DOMAIN, 2),
  retryAttempts: int(process.env.RETRY_ATTEMPTS, 2),
  retryDelayMs: int(process.env.RETRY_DELAY_MS, 5000),
  heloHostname: process.env.HELO_HOSTNAME || os.hostname(),
  senderEmail: process.env.SENDER_EMAIL || "verifier@localhost",
  senderEmailsByDomain: {},
  disposableDomainsPath: path.join(__dirname, "data", "disposable.txt"),
  rolePrefixesPath: path.join(__dirname, "data", "roles.txt"),
};
