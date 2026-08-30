#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { EmailVerifier } from "./src/verifier/verifier.js";
import { verifierConfig } from "./src/config.js";

function fmtBool(v: boolean): string {
  return String(v).toLowerCase();
}

function printVerify(result: Awaited<ReturnType<EmailVerifier["verifySingleEmail"]>>, rawJson: boolean): void {
  if (rawJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Email:        ${result.email}`);
  console.log(`Status:       ${result.status}`);
  console.log(`Confidence:   ${result.confidence.toFixed(2)}`);
  console.log(`Provider:     ${result.provider || "N/A"}`);
  console.log(`Sub-status:   ${result.subStatus}`);
  console.log(`Catch-all:    ${fmtBool(result.isCatchAllDomain)} (confidence: ${result.catchAllConfidence.toFixed(2)})`);
  console.log(`Disposable:   ${fmtBool(result.isDisposable)}`);
  if (result.portUsed) console.log(`Port:         ${result.portUsed}`);
  if (result.smtpCode !== null) console.log(`SMTP code:    ${result.smtpCode}`);
  if (result.smtpMessage) console.log(`Message:      ${result.smtpMessage.slice(0, 80)}`);
  console.log(`Duration:     ${result.durationMs}ms`);
  console.log(`Tier:         ${result.tierUsed === 1 ? "DNS only" : "SMTP"}`);
}

function readEmailsFromCsv(path: string): string[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());

  const emailIdx = header.indexOf("email");
  if (emailIdx === -1) {
    throw new Error("CSV must contain an 'email' column");
  }

  const emails: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const email = cols[emailIdx];
    if (email) emails.push(email);
  }
  return emails;
}

function toCsv(results: Awaited<ReturnType<EmailVerifier["verifySingleEmail"]>>[]): string {
  const header = [
    "email", "status", "confidence", "sub_status", "provider", "is_disposable",
    "is_role_based", "is_catch_all_domain", "catch_all_confidence", "mx_records",
    "smtp_code", "smtp_message", "port_used", "tier_used", "duration_ms", "cached",
  ];
  const rows = results.map((r) => [
    r.email, r.status, r.confidence, r.subStatus, r.provider, fmtBool(r.isDisposable),
    fmtBool(r.isRoleBased), fmtBool(r.isCatchAllDomain), r.catchAllConfidence,
    JSON.stringify(r.mxRecords), r.smtpCode, `"${(r.smtpMessage || "").replace(/"/g, '""')}"`,
    r.portUsed, r.tierUsed, r.durationMs, fmtBool(r.cached),
  ]);
  return [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  const verifier = new EmailVerifier(verifierConfig);
  await verifier.init();

  if (command === "verify") {
    const email = args[0];
    const rawJson = args.includes("--json");
    if (!email) {
      console.error("Usage: proxmail verify <email> [--json]");
      process.exit(1);
    }
    const result = await verifier.verifySingleEmail(email);
    printVerify(result, rawJson);
  } else if (command === "batch") {
    const input = args[0];
    let output = "results.csv";
    const outIdx = args.indexOf("--output");
    if (outIdx !== -1 && args[outIdx + 1]) output = args[outIdx + 1];

    if (!input) {
      console.error("Usage: proxmail batch <input.csv> [--output results.csv]");
      process.exit(1);
    }
    const emails = readEmailsFromCsv(input);
    if (emails.length === 0) {
      console.error("error: no emails found in CSV");
      process.exit(1);
    }
    console.log(`Verifying ${emails.length} email(s) from ${input} ...`);
    const results = await verifier.verifyMany(emails);
    const csv = toCsv(results);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(output, csv, "utf-8");
    console.log(`Results written to ${output}`);
  } else {
    console.error("Usage: proxmail verify <email> [--json] | proxmail batch <input.csv> [--output results.csv]");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
