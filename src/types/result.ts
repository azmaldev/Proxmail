export type VerifyStatus = "valid" | "invalid" | "unknown" | "unverifiable";

export interface VerifyResult {
  email: string;
  status: VerifyStatus;
  confidence: number;
  subStatus: string;
  provider: string;
  isDisposable: boolean;
  isRoleBased: boolean;
  isCatchAllDomain: boolean;
  catchAllConfidence: number;
  mxRecords: string[];
  smtpCode: number | null;
  smtpMessage: string | null;
  portUsed: number | null;
  tierUsed: 1 | 2;
  durationMs: number;
  cached: boolean;
}

export interface CatchAllResult {
  isCatchAll: boolean;
  confidence: number;
  probeCount: number;
  acceptCount: number;
  avgResponseMs: number;
  responseTimeVariance: number;
}

export interface ProviderInterpretation {
  status: VerifyStatus;
  subStatus: string;
  confidence: number;
  verifiable: boolean;
}

export interface SmtpResponse {
  code: number;
  message: string;
  port: number;
}

export interface VerifierConfig {
  timeoutMs: number;
  smtpTimeoutMs: number;
  dnsTimeoutMs: number;
  catchallTestEnabled: boolean;
  checkDisposableEnabled: boolean;
  rateLimitDelayMs: number;
  maxConcurrentDomains: number;
  maxConcurrentPerDomain: number;
  retryAttempts: number;
  retryDelayMs: number;
  heloHostname: string;
  senderEmail: string;
  senderEmailsByDomain: Record<string, string>;
  disposableDomainsPath: string;
  rolePrefixesPath: string;
}
