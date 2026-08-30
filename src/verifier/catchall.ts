import { randomUUID } from "node:crypto";
import type { CatchAllResult, SmtpResponse } from "../types/result.js";
import { performSmtpProbe, SmtpProbeError } from "./smtp.js";
import { SMTP_CODES_SUCCESS } from "./constants.js";

const KNOWN_FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoodns.net",
  "aol.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "mail.ru",
  "yandex.ru",
  "protonmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
]);

const PROBE_COUNT = 5;
const CONFIDENCE_THRESHOLD = 0.7;
const FAST_VARIANCE_MS = 50;
const SLOW_VARIANCE_MS = 200;
const TIME_SIGNAL_BONUS = 0.3;
const TIME_SIGNAL_PENALTY = -0.1;
const JITTER_MIN = 0.3;
const JITTER_RANGE = 0.4;

export interface CatchAllOptions {
  domain: string;
  mxHosts: string[];
  enabled: boolean;
  helo: string;
  senderEmail: string;
  smtpTimeoutMs: number;
  log?: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function isKnownFreemail(domain: string): boolean {
  return KNOWN_FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

export async function detectCatchAll(opts: CatchAllOptions): Promise<CatchAllResult> {
  if (!opts.enabled) {
    return { isCatchAll: false, confidence: 0, probeCount: 0, acceptCount: 0, avgResponseMs: 0, responseTimeVariance: 0 };
  }

  if (isKnownFreemail(opts.domain)) {
    opts.log?.(`Skipped catch-all ('${opts.domain}' is known freemail).`);
    return { isCatchAll: false, confidence: 0, probeCount: 0, acceptCount: 0, avgResponseMs: 0, responseTimeVariance: 0 };
  }

  await opts.sleep(Math.random() * 200);

  let acceptCount = 0;
  const responseTimes: number[] = [];

  for (let i = 0; i < PROBE_COUNT; i++) {
    const testEmail = `zz-probe-${randomUUID().slice(0, 8)}@${opts.domain}`;
    let accepted = false;

    if (i > 0) {
      await opts.sleep(JITTER_MIN + Math.random() * JITTER_RANGE);
    }

    for (const mxHost of opts.mxHosts) {
      if (accepted) break;
      try {
        const t0 = performance.now();
        const res: SmtpResponse = await performSmtpProbe({
          email: testEmail,
          domain: opts.domain,
          mxHost,
          helo: opts.helo,
          senderEmail: opts.senderEmail,
          alternativeSenders: [],
          smtpTimeoutMs: opts.smtpTimeoutMs,
        });
        const elapsed = performance.now() - t0;

        if (SMTP_CODES_SUCCESS.has(res.code)) {
          accepted = true;
          acceptCount++;
          responseTimes.push(elapsed);
          opts.log?.(`Probe ${i + 1}/${PROBE_COUNT}: '${testEmail}' accepted on ${mxHost} in ${elapsed.toFixed(1)}ms`);
          break;
        }
        opts.log?.(`Probe ${i + 1}/${PROBE_COUNT}: '${testEmail}' rejected on ${mxHost} (${res.code})`);
      } catch (err) {
        if (err instanceof SmtpProbeError) {
          opts.log?.(`Probe ${i + 1}/${PROBE_COUNT}: connection failed on ${mxHost}`);
        }
        // try next MX
      }
    }

    if (!accepted) {
      opts.log?.(`Probe ${i + 1}/${PROBE_COUNT}: '${testEmail}' not accepted`);
    }
  }

  const acceptRate = PROBE_COUNT > 0 ? acceptCount / PROBE_COUNT : 0;

  let variance = 0;
  if (responseTimes.length >= 2) {
    const mean = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    variance = responseTimes.reduce((acc, t) => acc + (t - mean) ** 2, 0) / responseTimes.length;
  }

  let timeSignal = 0;
  if (variance < FAST_VARIANCE_MS && acceptRate === 1) timeSignal = TIME_SIGNAL_BONUS;
  else if (variance > SLOW_VARIANCE_MS) timeSignal = TIME_SIGNAL_PENALTY;

  const confidence = Math.min(1, Math.max(0, acceptRate + timeSignal));
  const isCatchAll = confidence >= CONFIDENCE_THRESHOLD;
  const avg = responseTimes.length ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0;

  opts.log?.(
    `Catch-all result for '${opts.domain}': catch-all=${isCatchAll}, confidence=${confidence.toFixed(2)}, accepted ${acceptCount}/${PROBE_COUNT}, avg ${avg.toFixed(1)}ms, variance ${variance.toFixed(1)}ms`,
  );

  return {
    isCatchAll,
    confidence,
    probeCount: PROBE_COUNT,
    acceptCount,
    avgResponseMs: avg,
    responseTimeVariance: variance,
  };
}
