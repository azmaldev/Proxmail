import validator from "validator";

export interface SyntaxResult {
  valid: boolean;
  domain?: string;
  localPart?: string;
  error?: string;
}

export function validateSyntax(email: string): SyntaxResult {
  const trimmed = email.trim();

  if (!validator.isEmail(trimmed)) {
    return {
      valid: false,
      error: "The email address is not valid.",
    };
  }

  const at = trimmed.lastIndexOf("@");
  const localPart = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();

  return { valid: true, domain, localPart };
}
