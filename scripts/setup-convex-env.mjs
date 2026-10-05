#!/usr/bin/env node
/**
 * One-time Convex env setup for the deployment in .env.local (pass --prod for production).
 * Sets only what's missing, never prints secret values:
 *   JWT_PRIVATE_KEY / JWKS / SITE_URL  — @convex-dev/auth session signing
 *   ENCRYPTION_KEY                     — AES-GCM key for provider + search API keys
 *   JEV_API_KEY                        — OpenRouter key used ONLY for Jev decisions ("OpenRouter Jev API" in APIkeys.rtf)
 *   TMDB_API_KEY                       — TMDB read access token ("TMDB API Read Access Token" in APIkeys.rtf)
 *   SEARXNG_URLS                       — default web search pool (comma-separated SearXNG instances)
 * Shell env overrides the keys file. Also passed through when set: FIRECRAWL_API_KEY, APP_CONTACT,
 * JEV_MODEL, REGISTRY_URL. Chat models always come from providers the user adds in Settings.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const extra = process.argv.slice(2);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function convex(args) {
  return execFileSync(npx, ["convex", "env", ...args, ...extra], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const existing = new Set(
  convex(["list"])
    .split("\n")
    .map((line) => line.split("=")[0].trim())
    .filter(Boolean)
);

function set(name, value, { overwrite = false } = {}) {
  if (!value) return;
  if (existing.has(name) && !overwrite) {
    console.log(`= ${name} already set`);
    return;
  }
  convex(["set", name, "--", value]);
  console.log(`+ ${name} set`);
}

if (!existing.has("JWT_PRIVATE_KEY") || !existing.has("JWKS")) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString()
    .trimEnd()
    .replace(/\n/g, " ");
  const jwk = { ...publicKey.export({ format: "jwk" }), use: "sig", alg: "RS256" };
  set("JWT_PRIVATE_KEY", pem, { overwrite: true });
  set("JWKS", JSON.stringify({ keys: [jwk] }), { overwrite: true });
} else {
  console.log("= JWT_PRIVATE_KEY / JWKS already set");
}

set("SITE_URL", process.env.SITE_URL ?? "http://localhost:8081");
set("ENCRYPTION_KEY", randomBytes(32).toString("base64"));

/** Reads "Label:\nvalue" pairs from APIkeys.rtf (macOS textutil turns the RTF into plain text). */
function keysFile() {
  if (!existsSync("APIkeys.rtf")) return {};
  let text = readFileSync("APIkeys.rtf", "utf8");
  try {
    text = execFileSync("textutil", ["-convert", "txt", "-stdout", "APIkeys.rtf"], {
      encoding: "utf8",
    });
  } catch {
    /* not macOS: fall back to raw RTF */
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const after = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? lines[i + 1]?.replace(/[\\}]+$/, "") : undefined;
  };
  return {
    JEV_API_KEY: after(/^openrouter jev/i),
    TMDB_API_KEY: after(/^tmdb api read access token/i),
  };
}

const file = keysFile();
set("JEV_API_KEY", process.env.JEV_API_KEY ?? file.JEV_API_KEY, { overwrite: true });
set("TMDB_API_KEY", process.env.TMDB_API_KEY ?? file.TMDB_API_KEY, { overwrite: true });
set("SEARXNG_URLS", process.env.SEARXNG_URLS ?? "https://sx.xo.st,https://search.lumy.live");

for (const name of ["FIRECRAWL_API_KEY", "APP_CONTACT", "JEV_MODEL", "REGISTRY_URL"]) {
  set(name, process.env[name], { overwrite: true });
}

console.log("Done. ENCRYPTION_KEY must never change once provider keys are stored.");
