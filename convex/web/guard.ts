/** SSRF guard for model-chosen URLs: public http(s) only. */

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

export function publicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("Only http(s) URLs can be read.");
  if (PRIVATE_HOST.test(u.hostname)) throw new Error("Private and local addresses can't be read.");
  if (u.username || u.password) throw new Error("URLs with credentials can't be read.");
  return u;
}

/** Provider base URLs may be private (LM Studio at home) but never cloud metadata endpoints. */
export function providerUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Base URL must be a full URL, e.g. https://api.openai.com/v1");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("Base URL must be http(s).");
  if (/^169\.254\./.test(u.hostname) || u.hostname === "metadata.google.internal") {
    throw new Error("That address isn't allowed.");
  }
  return u;
}
