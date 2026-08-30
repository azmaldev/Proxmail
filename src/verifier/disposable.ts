import { promises as fs } from "node:fs";
import { warn } from "../lib/logger.js";

export class DisposableLoader {
  private domains: Set<string> = new Set();

  async load(filePath: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      this.domains = new Set();
      return;
    }
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      this.domains = new Set(lines);
    } catch {
      warn(`Disposable domains file '${filePath}' not found. Detection disabled.`);
      this.domains = new Set();
    }
  }

  source(filePath: string): Promise<void> {
    return this.load(filePath, true);
  }

  isDisposable(domain: string): boolean {
    const normalized = domain.toLowerCase();
    if (this.domains.has(normalized)) return true;
    const parts = normalized.split(".");
    // Parent-domain match: sub.example.com -> example.com
    if (parts.length > 2 && this.domains.has(parts.slice(-2).join("."))) {
      return true;
    }
    return false;
  }

  size(): number {
    return this.domains.size;
  }
}
