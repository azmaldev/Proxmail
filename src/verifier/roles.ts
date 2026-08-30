import { promises as fs } from "node:fs";
import { warn } from "../lib/logger.js";

export class RolePrefixLoader {
  private prefixes: Set<string> = new Set();

  async load(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0);
      this.prefixes = new Set(lines);
    } catch {
      warn(`Role-based prefixes file '${filePath}' not found. Detection disabled.`);
      this.prefixes = new Set();
    }
  }

  isRoleBased(localPart: string): boolean {
    return this.prefixes.has(localPart.toLowerCase());
  }

  size(): number {
    return this.prefixes.size;
  }
}
