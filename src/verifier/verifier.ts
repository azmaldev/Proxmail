import type {
  CatchAllResult,
  VerifyResult,
  VerifierConfig,
  SmtpResponse,
} from "../types/result.js";
import { validateSyntax } from "./syntax.js";
import { DisposableLoader } from "./disposable.js";
import { RolePrefixLoader } from "./roles.js";
import { DnsResolver } from "./dns.js";
import { detectCatchAll, isKnownFreemail } from "./catchall.js";
import {
  classifyProvider,
  interpretResponse,
  isTemporaryError,
} from "./provider.js";
import { performSmtpProbe, SmtpProbeError } from "./smtp.js";
import { info, warn } from "../lib/logger.js";

const RATE_LIMIT_PENALTY = 3;

class Semaphore {
  private current = 0;
  private waiters: Array<() => void> = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.current++;
  }

  release(): void {
    this.current--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export class EmailVerifier {
  private config: VerifierConfig;
  private dns: DnsResolver;
  private disposable: DisposableLoader;
  private roles: RolePrefixLoader;
  private globalSemaphore: Semaphore;
  private domainSemaphores: Map<string, Semaphore> = new Map();
  private lastProbeTime: Map<string, number> = new Map();
  private catchallCache: Map<string, CatchAllResult> = new Map();

  constructor(config: VerifierConfig) {
    this.config = config;
    this.dns = new DnsResolver(config.dnsTimeoutMs);
    this.disposable = new DisposableLoader();
    this.roles = new RolePrefixLoader();
    this.globalSemaphore = new Semaphore(config.maxConcurrentDomains);
  }

  async init(): Promise<void> {
    await Promise.all([
      this.disposable.load(this.config.disposableDomainsPath, this.config.checkDisposableEnabled),
      this.roles.load(this.config.rolePrefixesPath),
    ]);
    info(
      `EmailVerifier ready. HELO: ${this.config.heloHostname}, catch-all: ${this.config.catchallTestEnabled}, disposable: ${this.config.checkDisposableEnabled}, role prefixes: ${this.roles.size()}`,
    );
  }

  private domainSemaphore(domain: string): Semaphore {
    let sem = this.domainSemaphores.get(domain);
    if (!sem) {
      sem = new Semaphore(this.config.maxConcurrentPerDomain);
      this.domainSemaphores.set(domain, sem);
    }
    return sem;
  }

  private senderFor(domain: string): string {
    if (this.config.senderEmailsByDomain[domain]) {
      return this.config.senderEmailsByDomain[domain];
    }
    return this.config.senderEmail;
  }

  private async rateLimit(domain: string): Promise<void> {
    const last = this.lastProbeTime.get(domain) || 0;
    const wait = this.config.rateLimitDelayMs - (Date.now() - last);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastProbeTime.set(domain, Date.now());
  }

  async verifySingleEmail(email: string): Promise<VerifyResult> {
    const t0 = performance.now();
    const emit = (msg: string) => info(`[verify] ${msg}`);

    const syntax = validateSyntax(email);
    const localPart = syntax.valid ? (syntax.localPart as string) : "";
    const isRoleBased = this.roles.isRoleBased(localPart);

    if (!syntax.valid) {
      return this.buildResult({
        email,
        status: "invalid",
        subStatus: "syntax_error",
        confidence: 1,
        provider: "",
        mxRecords: [],
        smtpCode: null,
        smtpMessage: syntax.error || "Invalid email format",
        portUsed: null,
        isDisposable: false,
        isRoleBased,
        isCatchAllDomain: false,
        catchAllConfidence: 0,
        tierUsed: 1,
        t0,
      });
    }

    const domain = syntax.domain as string;

    if (this.disposable.isDisposable(domain)) {
      return this.buildResult({
        email,
        status: "invalid",
        subStatus: "disposable_domain",
        confidence: 1,
        provider: "",
        mxRecords: [],
        smtpCode: null,
        smtpMessage: "Domain is disposable.",
        portUsed: null,
        isDisposable: true,
        isRoleBased,
        isCatchAllDomain: false,
        catchAllConfidence: 0,
        tierUsed: 1,
        t0,
      });
    }

    let mxRecords: string[];
    try {
      mxRecords = await this.dns.resolveMx(domain);
    } catch {
      return this.buildResult({
        email,
        status: "invalid",
        subStatus: "dns_error_mx",
        confidence: 1,
        provider: "",
        mxRecords: [],
        smtpCode: null,
        smtpMessage: "Unable to resolve MX records for domain.",
        portUsed: null,
        isDisposable: false,
        isRoleBased,
        isCatchAllDomain: false,
        catchAllConfidence: 0,
        tierUsed: 1,
        t0,
      });
    }

    if (mxRecords.length === 0) {
      return this.buildResult({
        email,
        status: "invalid",
        subStatus: "no_mx_records",
        confidence: 1,
        provider: "",
        mxRecords: [],
        smtpCode: null,
        smtpMessage: "Domain has no MX records.",
        portUsed: null,
        isDisposable: false,
        isRoleBased,
        isCatchAllDomain: false,
        catchAllConfidence: 0,
        tierUsed: 1,
        t0,
      });
    }

    const catchAll = await this.catchAllFor(domain, mxRecords, email);
    const provider = classifyProvider(mxRecords);

    // --- SMTP phase with iterative retry ---
    let lastInterp: ReturnType<typeof interpretResponse> | null = null;
    let lastSmtpCode: number | null = null;
    let lastMsg = "";
    let lastPort: number | null = null;
    let lastException: unknown = null;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      let mxAllTried = true;

      for (const mxHost of mxRecords) {
        try {
          const res: SmtpResponse = await this.probeWithSemaphores(email, domain, mxHost, provider);
          const interp = interpretResponse(provider, res.code, res.message);

          lastSmtpCode = res.code;
          lastMsg = res.message;
          lastPort = res.port;
          lastInterp = interp;

          if (!interp.verifiable) {
            return this.buildResult({
              email, status: interp.status, subStatus: interp.subStatus,
              confidence: interp.confidence, provider, mxRecords,
              smtpCode: res.code, smtpMessage: res.message, portUsed: res.port,
              isDisposable: false, isRoleBased,
              isCatchAllDomain: catchAll.isCatchAll, catchAllConfidence: catchAll.confidence,
              tierUsed: 2, t0,
            });
          }
          if (interp.status === "valid") {
            return this.buildResult({
              email, status: "valid", subStatus: interp.subStatus,
              confidence: interp.confidence, provider, mxRecords,
              smtpCode: res.code, smtpMessage: res.message, portUsed: res.port,
              isDisposable: false, isRoleBased,
              isCatchAllDomain: catchAll.isCatchAll, catchAllConfidence: catchAll.confidence,
              tierUsed: 2, t0,
            });
          }
          if (interp.status === "invalid") {
            return this.buildResult({
              email, status: "invalid", subStatus: interp.subStatus,
              confidence: interp.confidence, provider, mxRecords,
              smtpCode: res.code, smtpMessage: res.message, portUsed: res.port,
              isDisposable: false, isRoleBased,
              isCatchAllDomain: catchAll.isCatchAll, catchAllConfidence: catchAll.confidence,
              tierUsed: 2, t0,
            });
          }
          // unknown — try next MX
          continue;
        } catch (err) {
          if (err instanceof SmtpProbeError && err.statusCode === "mail_from_temp_fail") {
            this.lastProbeTime.set(domain, Date.now() + this.config.rateLimitDelayMs * RATE_LIMIT_PENALTY);
            lastException = err;
            mxAllTried = false;
            break;
          }
          if (err instanceof SmtpProbeError) {
            warn(`Temp error for ${email} on ${mxHost}: ${err.message}`);
            lastException = err;
            if (attempt < this.config.retryAttempts) {
              mxAllTried = false;
              break;
            }
            continue;
          }
          warn(`Unexpected SMTP error for ${email} on ${mxHost}: ${(err as Error).message}`);
          continue;
        }
      }

      if (mxAllTried || lastException === null) break;

      if (attempt < this.config.retryAttempts) {
        const delay = this.config.retryDelayMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (lastInterp) {
      return this.buildResult({
        email, status: "unknown", subStatus: lastInterp.subStatus,
        confidence: lastInterp.confidence, provider, mxRecords,
        smtpCode: lastSmtpCode, smtpMessage: lastMsg, portUsed: lastPort,
        isDisposable: false, isRoleBased,
        isCatchAllDomain: catchAll.isCatchAll, catchAllConfidence: catchAll.confidence,
        tierUsed: 2, t0,
      });
    }

    return this.buildResult({
      email, status: "unknown", subStatus: "unreachable_all_mx",
      confidence: 0, provider, mxRecords,
      smtpCode: null, smtpMessage: "Cannot connect to any MX or all returned temp error.",
      portUsed: null, isDisposable: false, isRoleBased,
      isCatchAllDomain: catchAll.isCatchAll, catchAllConfidence: catchAll.confidence,
      tierUsed: 2, t0,
    });
  }

  private async probeWithSemaphores(
    email: string,
    domain: string,
    mxHost: string,
    provider: string,
  ): Promise<SmtpResponse> {
    const domainSem = this.domainSemaphore(domain);
    await this.rateLimit(domain);
    await this.globalSemaphore.acquire();
    await domainSem.acquire();
    try {
      return await performSmtpProbe({
        email,
        domain,
        mxHost,
        helo: this.config.heloHostname,
        senderEmail: this.senderFor(domain),
        alternativeSenders: Object.values(this.config.senderEmailsByDomain),
        smtpTimeoutMs: this.config.smtpTimeoutMs,
      });
    } finally {
      domainSem.release();
      this.globalSemaphore.release();
    }
  }

  private async catchAllFor(domain: string, mxRecords: string[], email: string): Promise<CatchAllResult> {
    if (!this.config.catchallTestEnabled) {
      return { isCatchAll: false, confidence: 0, probeCount: 0, acceptCount: 0, avgResponseMs: 0, responseTimeVariance: 0 };
    }
    const cached = this.catchallCache.get(domain);
    if (cached) return cached;

    if (isKnownFreemail(domain)) {
      const empty: CatchAllResult = { isCatchAll: false, confidence: 0, probeCount: 0, acceptCount: 0, avgResponseMs: 0, responseTimeVariance: 0 };
      this.catchallCache.set(domain, empty);
      return empty;
    }

    const result = await detectCatchAll({
      domain,
      mxHosts: mxRecords,
      enabled: true,
      helo: this.config.heloHostname,
      senderEmail: this.senderFor(domain),
      smtpTimeoutMs: this.config.smtpTimeoutMs,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    this.catchallCache.set(domain, result);
    return result;
  }

  async verifyMany(emails: string[]): Promise<VerifyResult[]> {
    return Promise.all(emails.map((email) => this.verifySingleEmail(email)));
  }

  private buildResult(args: {
    email: string;
    status: VerifyResult["status"];
    subStatus: string;
    confidence: number;
    provider: string;
    mxRecords: string[];
    smtpCode: number | null;
    smtpMessage: string | null;
    portUsed: number | null;
    isDisposable: boolean;
    isRoleBased: boolean;
    isCatchAllDomain: boolean;
    catchAllConfidence: number;
    tierUsed: 1 | 2;
    t0: number;
  }): VerifyResult {
    return {
      email: args.email,
      status: args.status,
      confidence: args.confidence,
      subStatus: args.subStatus,
      provider: args.provider,
      isDisposable: args.isDisposable,
      isRoleBased: args.isRoleBased,
      isCatchAllDomain: args.isCatchAllDomain,
      catchAllConfidence: args.catchAllConfidence,
      mxRecords: args.mxRecords,
      smtpCode: args.smtpCode,
      smtpMessage: args.smtpMessage,
      portUsed: args.portUsed,
      tierUsed: args.tierUsed,
      durationMs: Math.round(performance.now() - args.t0),
      cached: false,
    };
  }
}
