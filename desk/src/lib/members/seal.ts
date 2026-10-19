import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SALT = "inactivity-vault";

export function vaultConfigured(): boolean {
  return Boolean(process.env.VAULT_KEY && process.env.VAULT_KEY.length >= 16);
}

function key(): Buffer {
  const raw = process.env.VAULT_KEY;
  if (raw && raw.length >= 16) return scryptSync(raw, SALT, 32);
  if (process.env.DATABASE_URL) {
    throw new Error("The host vault secret is not set. Nothing was stored.");
  }
  return scryptSync("preview-desk-only", SALT, 32);
}

export function sealSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

export function openSecret(wrapped: string): string {
  const buf = Buffer.from(wrapped, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
