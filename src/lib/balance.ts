import type { Provider } from "@/lib/types";

/** Money with cents, so a balance draining reply by reply visibly moves. */
export function formatAmount(n: number, currency = "USD"): string {
  // Large figures drop the cents; minimum and maximum must agree or Intl throws.
  const digits = Math.abs(n) >= 10_000 ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    // A code Intl doesn't know (a gateway's own credits): the number with the code after it.
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** A month's spend, which is often fractions of a cent per reply. */
export function formatSpend(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under $0.01";
  return formatAmount(usd);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Remaining share of the limit, 0–1, once something has been spent against it. */
export function balanceFraction(p: Provider): number | null {
  const b = p.balance;
  if (b?.remaining === undefined || !b.total || b.remaining >= b.total) return null;
  return Math.min(1, Math.max(0, b.remaining / b.total));
}

/** "Resets in 2 h 10 min", or the day and time when it's more than a day away. */
export function resetLabel(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 60_000) return "Resets in a moment";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `Resets in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Resets in ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  const d = new Date(at);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Resets ${day} ${time}`;
}

/** "$12.48 left" for a provider row, or what's been used when there's no limit; null when unknown. */
export function balanceLine(p: Provider): string | null {
  if (p.subscription) {
    const w = [...(p.limits?.windows ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return w ? `${Math.round(w.usedPercent)}% of ${w.label.toLowerCase()} used` : null;
  }
  const b = p.balance;
  if (!b || b.status === "unsupported") return null;
  if (b.remaining !== undefined) return `${formatAmount(b.remaining, b.currency)} left`;
  if (b.used !== undefined) return `${formatAmount(b.used, b.currency)} used`;
  return null;
}

/** This month's spend from the app, when it applies to the month showing now. */
export function monthUsage(p: Provider, now = Date.now()) {
  const u = p.usage;
  return u && u.month === new Date(now).toISOString().slice(0, 7) ? u : null;
}
