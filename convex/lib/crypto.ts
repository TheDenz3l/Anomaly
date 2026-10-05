/**
 * AES-GCM for provider and search keys (PRD §3.4). The key lives only in the Convex env
 * (ENCRYPTION_KEY, base64 of 32 random bytes); ciphertexts never leave the backend.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(): Promise<CryptoKey> {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set on this Convex deployment. Run npm run setup:convex."
    );
  }
  const bytes = fromBase64(raw.trim());
  if (bytes.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(),
    encoder.encode(plain)
  );
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(blob: string): Promise<string> {
  const [version, iv, data] = blob.split(":");
  if (version !== "v1" || !iv || !data) throw new Error("Unrecognised secret format.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    await aesKey(),
    fromBase64(data)
  );
  return decoder.decode(plain);
}

/**
 * API keys never contain whitespace, and no provider issues keys starting "Sk-". Both show up when a
 * key is copied out of a note or document that auto-capitalizes or wraps lines, and both make the
 * provider answer 401.
 */
export function normalizeApiKey(raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  return compact.startsWith("Sk-") ? `s${compact.slice(1)}` : compact;
}

/** "sk-…4f2a" style hint, safe to show in Settings. */
export function secretHint(secret: string | undefined): string {
  if (!secret) return "none";
  const prefix = secret.match(/^[a-z]{1,6}-(?:[a-z]{1,6}-)?/i)?.[0] ?? "";
  return `${prefix}…${secret.slice(-4)}`;
}

const SENSITIVE_HEADER = /auth|key|token|secret|cookie|password/i;

export function maskHeaders(headers: { key: string; value: string }[]) {
  return headers.map((h) => ({
    key: h.key,
    value: SENSITIVE_HEADER.test(h.key) ? secretHint(h.value) : h.value,
  }));
}
