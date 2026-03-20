import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32) {
    return base64;
  }
  const hex = Buffer.from(trimmed, "hex");
  if (hex.length === 32) {
    return hex;
  }
  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.length === 32) {
    return utf8;
  }
  throw new Error("FLAMECAST_BROKER_ENCRYPTION_KEY must decode to 32 bytes");
}

export interface SealedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptJson(value: unknown, rawKey: string): SealedValue {
  const key = decodeKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptJson<T>(
  value: SealedValue,
  rawKey: string,
  parse: (input: unknown) => T,
): T {
  const key = decodeKey(rawKey);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);
  return parse(JSON.parse(decrypted.toString("utf8")));
}
