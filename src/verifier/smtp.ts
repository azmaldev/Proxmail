import net from "node:net";
import tls from "node:tls";
import type { SmtpResponse } from "../types/result.js";
import { isReputationError } from "./provider.js";

const PORT_SEQUENCE = [
  { port: 25, useTls: false, startTls: true },
  { port: 587, useTls: false, startTls: true },
  { port: 465, useTls: true, startTls: false },
];

const SUCCESS_CODES = new Set([250, 251, 252]);
const TEMP_FAIL_CODES = new Set([421, 450, 451, 452]);

export class SmtpProbeError extends Error {
  statusCode: string;
  constructor(message: string, statusCode: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Minimal SMTP client over node:net / node:tls.
 * Sends commands and parses RFC-5321 multiline replies.
 */
class SmtpClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private queue: Array<{ resolve: (r: SmtpResponse) => void; reject: (e: Error) => void }> = [];
  private buffer = "";
  private helo: string;
  private timeoutMs: number;

  constructor(helo: string, timeoutMs: number) {
    this.helo = helo;
    this.timeoutMs = timeoutMs;
  }

  connect(host: string, port: number, useTls: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let sock: net.Socket;
      if (useTls) {
        sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
      } else {
        sock = net.createConnection({ host, port });
      }

      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };

      sock.once("error", onError);
      sock.setTimeout(this.timeoutMs);
      sock.on("timeout", () => {
        sock.destroy(new Error("socket timeout"));
      });
      sock.on("data", (chunk) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });
      sock.on("close", () => {
        this.failAll(new Error("connection closed"));
      });

      const connected = useTls ? "secureConnect" : "connect";
      sock.once(connected, () => {
        sock.removeListener("error", onError);
        this.socket = sock;
        this.readGreeting()
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  private readGreeting(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy(new Error("greeting timeout"));
        reject(new Error("greeting timeout"));
      }, this.timeoutMs);
      const check = () => {
        const res = this.parseCompleteResponse();
        if (res) {
          clearTimeout(timer);
          resolve();
        }
      };
      this.onReady = check;
      check();
    });
  }

  private onReady: (() => void) | null = null;
  private failAll(err: Error): void {
    if (this.onReady) {
      this.onReady = null;
    }
    while (this.queue.length) {
      const item = this.queue.shift()!;
      item.reject(err);
    }
  }

  private parseCompleteResponse(): SmtpResponse | null {
    // Must find a full multiline response: lines ending with \r\n, final line "<code> <text>".
    const lines = this.buffer.split("\r\n");
    let code: number | null = null;
    let message = "";
    let consumed = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") {
        if (i > 0) {
          // trailing empty line after complete response
          consumed = i;
          break;
        }
        continue;
      }
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) break;
      const lineCode = Number(match[1]);
      const sep = match[2];
      if (code === null) code = lineCode;
      if (sep === " ") {
        // final line of the response
        message += (message ? "\n" : "") + match[3].trim();
        consumed = i + 1;
        this.takeConsumed(consumed);
        return { code, message, port: 0 };
      }
      // continuation line
      message += (message ? "\n" : "") + match[3].trim();
    }
    return null; // incomplete
  }

  private takeConsumed(count: number): void {
    const rest = this.buffer.split("\r\n").slice(count).join("\r\n");
    this.buffer = rest;
  }

  private processBuffer(): void {
    if (this.onReady) {
      const res = this.parseCompleteResponse();
      if (res && this.onReady) {
        const cb = this.onReady;
        this.onReady = null;
        cb();
      }
    }
    if (this.queue.length) {
      const res = this.parseCompleteResponse();
      if (res) {
        const item = this.queue.shift()!;
        item.resolve({ ...res, port: res.port });
      }
    }
  }

  private request(command: string): Promise<SmtpResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("not connected"));
        return;
      }
      this.queue.push({ resolve, reject });
      this.socket.write(command + "\r\n");
    });
  }

  async ehlo(): Promise<void> {
    const res = await this.request(`EHLO ${this.helo}`);
    if (res.code >= 400) {
      await this.request(`HELO ${this.helo}`);
    }
  }

  async startTls(): Promise<boolean> {
    const res = await this.request("STARTTLS");
    return res.code < 400;
  }

  upgradeToTls(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket as net.Socket;
      const upgraded = tls.connect({
        socket: plain,
        servername: host,
        rejectUnauthorized: false,
      });
      const timer = setTimeout(() => {
        upgraded.destroy(new Error("starttls upgrade timeout"));
        reject(new Error("starttls upgrade timeout"));
      }, this.timeoutMs);
      upgraded.once("secureConnect", () => {
        clearTimeout(timer);
        this.socket = upgraded;
        // Re-attach data/close handlers now that this.socket points to upgraded
        upgraded.on("data", (chunk) => {
          this.buffer += chunk.toString("utf-8");
          this.processBuffer();
        });
        upgraded.on("close", () => this.failAll(new Error("connection closed")));
        resolve();
      });
      upgraded.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  mail(sender: string): Promise<SmtpResponse> {
    return this.request(`MAIL FROM:<${sender}>`);
  }

  rcpt(recipient: string): Promise<SmtpResponse> {
    return this.request(`RCPT TO:<${recipient}>`);
  }

  async rset(): Promise<void> {
    try {
      await this.request("RSET");
    } catch {
      /* ignore */
    }
  }

  async quit(): Promise<void> {
    try {
      await this.request("QUIT");
    } catch {
      /* ignore */
    }
    this.socket?.destroy();
    this.socket = null;
  }
}

export interface ProbeOptions {
  email: string;
  domain: string;
  mxHost: string;
  helo: string;
  senderEmail: string;
  alternativeSenders: string[];
  smtpTimeoutMs: number;
}

export async function performSmtpProbe(opts: ProbeOptions): Promise<SmtpResponse> {
  let client: SmtpClient | null = null;
  let lastError: Error | null = null;
  let connectedPort = 0;

  for (const cfg of PORT_SEQUENCE) {
    try {
      client = new SmtpClient(opts.helo, opts.smtpTimeoutMs);
      await client.connect(opts.mxHost, cfg.port, cfg.useTls);
      connectedPort = cfg.port;
      await client.ehlo();

      if (cfg.startTls) {
        const ok = await client.startTls();
        if (ok) {
          await client.upgradeToTls(opts.mxHost);
          await client.ehlo();
        } else {
          // STARTTLS not available; continue in plaintext on this port
        }
      }
      break;
    } catch (err) {
      lastError = err as Error;
      client = null;
    }
  }

  if (!client) {
    throw new SmtpProbeError(
      `Connect error to ${opts.mxHost}: all ports failed - ${lastError?.message}`,
      "smtp_connect_error",
    );
  }

  try {
    let mailRes = await client.mail(opts.senderEmail);

    if (isReputationError(mailRes.code, mailRes.message)) {
      const alt = opts.alternativeSenders.find((s) => s && s !== opts.senderEmail);
      if (alt) {
        mailRes = await client.mail(alt);
      }
    }

    if (!SUCCESS_CODES.has(mailRes.code)) {
      if (TEMP_FAIL_CODES.has(mailRes.code)) {
        throw new SmtpProbeError(
          `MAIL FROM temp error: ${mailRes.code} ${mailRes.message}`,
          "mail_from_temp_fail",
        );
      }
      throw new SmtpProbeError(
        `MAIL FROM perm error: ${mailRes.code} ${mailRes.message}`,
        "mail_from_perm_fail",
      );
    }

    const rcptRes = await client.rcpt(opts.email);
    await client.rset();
    return { ...rcptRes, port: connectedPort };
  } finally {
    await client.quit();
  }
}
