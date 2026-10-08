import { CODEX_BASE } from "./codex";
import { requestJson, type Endpoint } from "./openai";

/**
 * Signing in with a ChatGPT plan (Plus, Pro, Business) through OpenAI's device-code flow, the one
 * Codex offers where there's no browser callback: the app shows a code, the user approves it at
 * auth.openai.com, and the server trades the approval for tokens. Replies then go to the Codex
 * backend on the plan's own limits, which are read back as the 5-hour and weekly windows.
 */

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_CALLBACK = "https://auth.openai.com/deviceauth/callback";
export const CHATGPT_VERIFY_URL = "https://auth.openai.com/codex/device";
const BACKEND = "https://chatgpt.com/backend-api";
/** Names this app to OpenAI on every request, as Codex names itself. */
const ORIGINATOR = "anomaly";
/** The Codex release whose model list the backend should answer with. */
const CLIENT_VERSION = "0.159.2";
const TIMEOUT_MS = 15_000;
/** Tokens are refreshed this long before they expire. */
export const REFRESH_EARLY_MS = 30 * 60_000;

export class ChatgptAuthError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export type ChatgptTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
  accountId: string;
  email?: string;
  plan?: string;
};

function decodeJwt(token: string): Record<string, any> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function failure(res: Response, what: string): Promise<ChatgptAuthError> {
  const body = await res.text().catch(() => "");
  let detail = body.slice(0, 200);
  try {
    const j = JSON.parse(body);
    detail = String(j.error_description ?? j.error?.message ?? j.message ?? j.error ?? detail);
  } catch {
    // Not JSON: the start of the body says enough.
  }
  return new ChatgptAuthError(`${what} (${res.status}${detail ? `: ${detail}` : ""})`, res.status);
}

function readTokens(json: any, previousRefresh?: string): ChatgptTokens {
  const access = text(json?.access_token);
  if (!access) throw new ChatgptAuthError("OpenAI sent no access token.", 0);
  const a = decodeJwt(access);
  const id = json?.id_token ? decodeJwt(json.id_token) : null;
  const auth = a?.["https://api.openai.com/auth"] ?? {};
  const idAuth = id?.["https://api.openai.com/auth"] ?? {};
  const accountId = text(auth.chatgpt_account_id) ?? text(idAuth.chatgpt_account_id);
  if (!accountId) throw new ChatgptAuthError("Signed in, but the account has no ChatGPT plan.", 0);
  const exp = typeof a?.exp === "number" ? a.exp * 1000 : undefined;
  const expiresIn = typeof json?.expires_in === "number" ? json.expires_in * 1000 : undefined;
  return {
    access,
    refresh: text(json?.refresh_token) ?? previousRefresh ?? "",
    expiresAt: exp ?? Date.now() + (expiresIn ?? 3600_000),
    accountId,
    email: (
      text(a?.["https://api.openai.com/profile"]?.email) ??
      text(id?.["https://api.openai.com/profile"]?.email) ??
      text(id?.email)
    )?.toLowerCase(),
    plan: text(auth.chatgpt_plan_type) ?? text(idAuth.chatgpt_plan_type),
  };
}

/** Starts a sign-in: the code to show and the id the server polls with. */
export async function startDeviceAuth(): Promise<{
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}> {
  const res = await fetch(USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, "OpenAI didn't start the sign-in");
  const json = await res.json();
  const deviceAuthId = text(json?.device_auth_id);
  const userCode = text(json?.user_code ?? json?.usercode);
  if (!deviceAuthId || !userCode) throw new ChatgptAuthError("OpenAI sent no sign-in code.", 0);
  const interval = Number(json?.interval) || 5;
  return { deviceAuthId, userCode, intervalMs: Math.max(3, interval) * 1000 };
}

/** One poll: null while the code waits for approval, the tokens once it's approved. */
export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string
): Promise<ChatgptTokens | null> {
  const res = await fetch(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw await failure(res, "OpenAI didn't approve the sign-in");
  const json = await res.json();
  const code = text(json?.authorization_code);
  const verifier = text(json?.code_verifier);
  if (!code || !verifier) throw new ChatgptAuthError("OpenAI's approval was incomplete.", 0);
  const token = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_CALLBACK,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!token.ok) throw await failure(token, "OpenAI didn't finish the sign-in");
  return readTokens(await token.json());
}

export async function refreshTokens(refresh: string): Promise<ChatgptTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, "OpenAI didn't renew the sign-in");
  return readTokens(await res.json(), refresh);
}

/** Headers every request to the ChatGPT backend carries (the token itself is the bearer key). */
export function chatgptHeaders(accountId: string): { key: string; value: string }[] {
  return [
    { key: "chatgpt-account-id", value: accountId },
    { key: "OpenAI-Beta", value: "responses=experimental" },
    { key: "originator", value: ORIGINATOR },
  ];
}

export const CHATGPT_BASE = CODEX_BASE;

/** The models the plan can use, shaped like a /models entry. */
export async function listChatgptModels(ep: Endpoint): Promise<any[]> {
  const json = await requestJson(ep, `/models?client_version=${CLIENT_VERSION}`, {
    timeoutMs: 20_000,
  });
  const models: any[] = Array.isArray(json?.models) ? json.models : [];
  return models
    .filter((m) => typeof m?.slug === "string" && (m.visibility ?? "list") === "list")
    .map((m) => ({
      ...m,
      id: m.slug,
      name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      context_length: m.max_context_window ?? m.context_window,
    }));
}

export type LimitWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowMinutes?: number;
};

const SESSION_MAX_SECONDS = 6 * 3600;

function readWindow(w: any, id: string, label: string): LimitWindow | null {
  if (!w || typeof w !== "object") return null;
  const used = Number(w.used_percent ?? w.usedPercent);
  if (!Number.isFinite(used)) return null;
  const at = Number(w.reset_at ?? w.resetAt);
  const after = Number(w.reset_after_seconds ?? w.resetAfterSeconds);
  const seconds = Number(w.limit_window_seconds ?? w.limitWindowSeconds);
  return {
    id,
    label,
    usedPercent: Math.max(0, Math.min(100, used)),
    resetsAt:
      Number.isFinite(at) && at > 0
        ? at * 1000
        : Number.isFinite(after) && after > 0
          ? Date.now() + after * 1000
          : undefined,
    windowMinutes: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : undefined,
  };
}

/** The plan's usage windows: the rolling 5-hour limit and the weekly one. */
export async function fetchChatgptLimits(
  ep: Endpoint
): Promise<{ plan?: string; windows: LimitWindow[] }> {
  const json = await requestJson({ ...ep, baseUrl: BACKEND }, "/wham/usage", {
    timeoutMs: TIMEOUT_MS,
  });
  const rate = json?.rate_limit ?? json?.rateLimit ?? {};
  const raw = [
    rate.primary_window ?? rate.primaryWindow,
    rate.secondary_window ?? rate.secondaryWindow,
  ];
  let session: any;
  let weekly: any;
  for (const w of raw) {
    if (!w) continue;
    const seconds = Number(w.limit_window_seconds ?? w.limitWindowSeconds);
    if (Number.isFinite(seconds) && seconds <= SESSION_MAX_SECONDS) session ??= w;
    else weekly ??= w;
  }
  const windows = [
    readWindow(session, "session", "5-hour limit"),
    readWindow(weekly, "weekly", "Weekly limit"),
  ].filter((w): w is LimitWindow => w !== null);
  return { plan: text(json?.plan_type ?? json?.planType), windows };
}
