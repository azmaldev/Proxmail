import type { ProviderInterpretation } from "../types/result.js";

const MX_PATTERNS: Record<string, string[]> = {
  google_workspace: ["google.com", "googlemail.com", "aspmx.l.google.com"],
  microsoft_365: ["mail.protection.outlook.com", "outlook.com"],
  proofpoint: ["pphosted.com"],
  mimecast: ["mimecast.com"],
  barracuda: ["barracudanetworks.com"],
  yahoo: ["yahoodns.net", "yahoo.com"],
  zoho: ["zoho.com"],
};

export function classifyProvider(mxRecords: string[]): string {
  for (const mx of mxRecords) {
    const mxLower = mx.toLowerCase();
    for (const provider of Object.keys(MX_PATTERNS)) {
      for (const pattern of MX_PATTERNS[provider]) {
        if (mxLower === pattern || mxLower.endsWith(`.${pattern}`)) {
          return provider;
        }
      }
    }
  }
  return "self_hosted";
}

const REPUTATION_KEYWORDS = ["poor reputation", "reputation", "spam", "blocked", "blacklisted", "rejected"];

export function isReputationError(code: number, message: string): boolean {
  if (code === 554) return true;
  const lower = (message || "").toLowerCase();
  return REPUTATION_KEYWORDS.some((kw) => lower.includes(kw));
}

const TEMPORARY_CODES = new Set([421, 450, 451, 452, 454, 458, 459, 471, 472, 552, 553, 554]);
const TEMP_KEYWORDS = [
  "temporary",
  "try again",
  "later",
  "busy",
  "overloaded",
  "rate limit",
  "throttled",
  "quota",
  "limit exceeded",
];

export function isTemporaryError(code: number, message: string): boolean {
  if (TEMPORARY_CODES.has(code)) return true;
  const lower = (message || "").toLowerCase();
  return TEMP_KEYWORDS.some((kw) => lower.includes(kw));
}

export function interpretResponse(
  provider: string,
  smtpCode: number,
  smtpMessage: string,
): ProviderInterpretation {
  const msg = (smtpMessage || "").toLowerCase();

  if (provider === "google_workspace") {
    return {
      status: "unverifiable",
      subStatus: "provider_blocks_smtp_probe",
      confidence: 0.5,
      verifiable: false,
    };
  }

  if (provider === "microsoft_365" && smtpCode === 550) {
    const confidence = msg.includes("5.7.1") ? 0.4 : 0.3;
    return {
      status: "unknown",
      subStatus: "probe_blocked_by_defender",
      confidence,
      verifiable: false,
    };
  }

  if (provider === "proofpoint" && smtpCode === 452) {
    return {
      status: "unknown",
      subStatus: "greylisted_retry_30s",
      confidence: 0.5,
      verifiable: true,
    };
  }

  if (smtpCode === 250) {
    return { status: "valid", subStatus: "smtp_accepted", confidence: 0.9, verifiable: true };
  }
  if (smtpCode === 550) {
    return { status: "invalid", subStatus: "mailbox_rejected", confidence: 0.95, verifiable: true };
  }
  if (smtpCode >= 400 && smtpCode < 500) {
    return { status: "unknown", subStatus: "temporary_failure", confidence: 0.3, verifiable: true };
  }
  return { status: "unknown", subStatus: "unrecognized_response", confidence: 0.1, verifiable: false };
}
