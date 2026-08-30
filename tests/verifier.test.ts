import { describe, it, expect } from "vitest";
import { validateSyntax } from "../src/verifier/syntax.js";
import { DisposableLoader } from "../src/verifier/disposable.js";
import { RolePrefixLoader } from "../src/verifier/roles.js";
import { classifyProvider, interpretResponse, isTemporaryError } from "../src/verifier/provider.js";

describe("syntax", () => {
  it("validates a correct email", () => {
    const r = validateSyntax("user@example.com");
    expect(r.valid).toBe(true);
    expect(r.domain).toBe("example.com");
    expect(r.localPart).toBe("user");
  });

  it("rejects malformed email", () => {
    const r = validateSyntax("not-a-valid-email@@");
    expect(r.valid).toBe(false);
  });

  it("lowercases the domain", () => {
    const r = validateSyntax("User@Example.COM");
    expect(r.domain).toBe("example.com");
    expect(r.localPart).toBe("User");
  });
});

describe("disposable", () => {
  it("detects exact disposable domain", async () => {
    const loader = new DisposableLoader();
    await loader.load("src/data/disposable.txt", true);
    expect(loader.isDisposable("mailinator.com")).toBe(true);
  });

  it("detects parent domain for subdomains", async () => {
    const loader = new DisposableLoader();
    await loader.load("src/data/disposable.txt", true);
    expect(loader.isDisposable("sub.mailinator.com")).toBe(true);
  });

  it("rejects a normal domain", async () => {
    const loader = new DisposableLoader();
    await loader.load("src/data/disposable.txt", true);
    expect(loader.isDisposable("gmail.com")).toBe(false);
  });
});

describe("roles", () => {
  it("detects role-based prefixes", async () => {
    const loader = new RolePrefixLoader();
    await loader.load("src/data/roles.txt");
    expect(loader.isRoleBased("admin")).toBe(true);
    expect(loader.isRoleBased("info")).toBe(true);
    expect(loader.isRoleBased("john.doe")).toBe(false);
  });
});

describe("provider", () => {
  it("classifies google workspace", () => {
    expect(classifyProvider(["aspmx.l.google.com"])).toBe("google_workspace");
    expect(classifyProvider(["alt1.aspmx.l.google.com"])).toBe("google_workspace");
  });

  it("classifies microsoft 365", () => {
    expect(classifyProvider(["mx1.mail.protection.outlook.com"])).toBe("microsoft_365");
  });

  it("falls back to self_hosted", () => {
    expect(classifyProvider(["mx.example.com"])).toBe("self_hosted");
  });

  it("interprets google as unverifiable", () => {
    const i = interpretResponse("google_workspace", 250, "ok");
    expect(i.status).toBe("unverifiable");
    expect(i.verifiable).toBe(false);
  });

  it("interprets 250 as valid", () => {
    expect(interpretResponse("self_hosted", 250, "ok").status).toBe("valid");
  });

  it("interprets 550 as invalid", () => {
    expect(interpretResponse("self_hosted", 550, "mailbox not found").status).toBe("invalid");
  });

  it("recognizes temporary errors", () => {
    expect(isTemporaryError(421, "try again later")).toBe(true);
    expect(isTemporaryError(550, "mailbox not found")).toBe(false);
  });
});
