import { Spinner } from "heroui-native";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, Pill } from "@/genui/kit";
import { modelRef } from "@/lib/models";
import { useApp } from "@/lib/store";
import { colors, fonts, LIST_RADIUS } from "@/lib/theme";
import type { CapabilityProfile, Model, Provider } from "@/lib/types";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, ReactNode, RefObject } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  TextInputProps,
} from "react-native";
import Animated, { SlideInLeft, SlideInRight } from "react-native-reanimated";
import { Favicon } from "@/components/ui/Favicon";
import { FormSheet, GROUP_BG } from "@/components/ui/FormSheet";
import { openLink } from "@/lib/links";
import {
  balanceFraction,
  formatAmount,
  formatSpend,
  formatTokens,
  monthUsage,
  resetLabel,
  timeAgo,
} from "@/lib/balance";

type Preset = {
  id: string;
  label: string;
  baseUrl: string;
  /** Site whose icon stands for the service. */
  site: string;
  /** Where people create a key. */
  keys: string;
};

/** Hosted APIs that speak OpenAI's chat and /models endpoints with a bearer key. */
const PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    site: "openai.com",
    keys: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    site: "anthropic.com",
    keys: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    site: "openrouter.ai",
    keys: "https://openrouter.ai/settings/keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    site: "gemini.google.com",
    keys: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    site: "groq.com",
    keys: "https://console.groq.com/keys",
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    site: "x.ai",
    keys: "https://console.x.ai",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    site: "deepseek.com",
    keys: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    site: "mistral.ai",
    keys: "https://console.mistral.ai/api-keys",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    site: "together.ai",
    keys: "https://api.together.ai/settings/api-keys",
  },
];

type Draft = {
  providerId: string;
  label: string;
  baseUrl: string;
  headers: { key: string; value: string }[];
};
const blank: Draft = { providerId: "", label: "", baseUrl: "", headers: [] };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const URL_RE = /^https?:\/\/[^\s/]+\S*$/;

const hostOf = (url: string) =>
  url
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
/** Typed URLs: add the scheme people leave off and drop a trailing slash. */
function tidyUrl(raw: string) {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}
const presetFor = (baseUrl: string) =>
  PRESETS.find((p) => hostOf(p.baseUrl) === hostOf(baseUrl)) ?? null;
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const cleanKey = (t: string) => t.replace(/\s+/g, "");

/** Alert.alert does nothing on web (react-native-web stubs it), so web asks with confirm(). */
function confirmDestructive(
  title: string,
  message: string | undefined,
  labels: { cancel: string; confirm: string },
  onConfirm: () => void
) {
  if (Platform.OS === "web") {
    const ask = (globalThis as { confirm?: (text: string) => boolean }).confirm;
    if (!ask || ask(message ? `${title}\n\n${message}` : title)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: labels.cancel, style: "cancel" },
    { text: labels.confirm, style: "destructive", onPress: onConfirm },
  ]);
}

function Divider({ inset = 16 }: { inset?: number }) {
  return <View pointerEvents="none" style={[styles.divider, { left: inset }]} />;
}

function Footnote({ children }: { children: ReactNode }) {
  return (
    <Text muted className="text-[13px] leading-[18px]">
      {children}
    </Text>
  );
}

/** Inset grouped section, as in iOS Settings. */
function FormGroup({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <View className="mb-6">
      <View style={styles.group}>{children}</View>
      {footer ? <View className="mt-2 gap-1.5 px-4">{footer}</View> : null}
    </View>
  );
}

function Notice({ tone, children }: { tone: "busy" | "danger"; children: string }) {
  const color = tone === "busy" ? colors.textMuted : colors.danger;
  return (
    <View accessibilityLiveRegion="polite" className="flex-row items-start gap-2">
      {tone === "busy" ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Icon name="alert-circle" size={16} color={color} />
      )}
      <Text className="flex-1 text-[13px] leading-[18px]" style={{ color }}>
        {children}
      </Text>
    </View>
  );
}

/** Label on the left, field on the right; tapping anywhere on the row focuses the field. */
function FieldRow({
  label,
  inputRef,
  last,
  accessory,
  ...input
}: {
  label: string;
  inputRef: RefObject<TextInput | null>;
  last?: boolean;
  accessory?: ReactNode;
} & TextInputProps) {
  return (
    <Pressable accessible={false} onPress={() => inputRef.current?.focus()} style={styles.row}>
      <Text weight="medium" style={styles.rowLabel}>
        {label}
      </Text>
      <TextInput
        ref={inputRef}
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, input.editable === false ? { color: colors.textMuted } : null]}
      />
      {accessory}
      {last ? null : <Divider />}
    </Pressable>
  );
}

function ListRow({
  icon,
  label,
  detail,
  right,
  last,
  danger,
  onPress,
}: {
  icon?: ReactNode;
  label: string;
  detail?: string;
  right?: ReactNode;
  last?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      onPress={onPress}
      style={styles.listRow}
    >
      {icon}
      <View className="flex-1">
        <Text
          weight="medium"
          className="text-base"
          style={danger ? { color: colors.danger } : undefined}
        >
          {label}
        </Text>
        {detail ? (
          <Text muted className="text-[13px] leading-[18px]">
            {detail}
          </Text>
        ) : null}
      </View>
      {right}
      {danger ? null : <Icon name="chevron-forward" size={16} color={colors.textFaint} />}
      {last ? null : <Divider inset={icon ? 60 : 16} />}
    </Tap>
  );
}

/** One tap to paste a copied key; iOS asks once before an app reads the clipboard. */
function PasteKey({ onPaste }: { onPaste: (text: string) => void }) {
  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text.trim()) onPaste(text);
  };
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel="Paste key"
      hitSlop={6}
      onPress={() => void paste()}
      style={styles.paste}
    >
      <Text weight="medium" className="text-[13px]">
        Paste
      </Text>
    </Tap>
  );
}

function Identity({
  site,
  name,
  detail,
  dot,
}: {
  site: string;
  name: string;
  detail: string;
  dot?: string;
}) {
  return (
    <View className="mb-5 flex-row items-center gap-3.5 px-1 pt-1">
      <Favicon url={site} size={48} />
      <View className="flex-1">
        <Text weight="bold" className="text-[20px] leading-[26px]" numberOfLines={1}>
          {name}
        </Text>
        <View className="flex-row items-center gap-1.5">
          {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
          <Text muted className="flex-1 text-[13px] leading-[18px]" numberOfLines={2}>
            {detail}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** How often an open sheet reads the balance again; the server answers from its copy when it's fresh. */
const BALANCE_POLL_MS = 20_000;

/** Used share of a window, coloured as it nears the limit. */
function limitColor(used: number): string {
  return used >= 95 ? colors.danger : used >= 80 ? colors.warning : colors.success;
}

/**
 * A signed-in plan's usage windows (the rolling 5-hour limit and the weekly one), read again
 * while the sheet is open and after every reply.
 */
function PlanLimits({
  provider,
  now,
  busy,
  onRefresh,
}: {
  provider: Provider;
  now: number;
  busy: boolean;
  onRefresh: () => void;
}) {
  const l = provider.limits;
  const usage = monthUsage(provider, now);
  const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;
  return (
    <View className="mb-6">
      <View className="mb-2 flex-row items-center justify-between px-4">
        <Text weight="medium" muted className="text-[13px]">
          Usage limits
        </Text>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Refresh usage limits"
          disabled={busy}
          hitSlop={8}
          onPress={onRefresh}
          className="flex-row items-center gap-1.5"
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primaryStrong} />
          ) : (
            <Icon name="refresh" size={14} color={colors.primaryStrong} />
          )}
          <Text weight="medium" className="text-[13px] text-primary-strong">
            Refresh
          </Text>
        </Tap>
      </View>
      <View style={styles.group}>
        {l?.windows.length ? (
          l.windows.map((w, i) => (
            <View
              key={w.id}
              accessibilityLiveRegion="polite"
              className="px-4 py-4"
              style={i > 0 ? styles.topRule : undefined}
            >
              <View className="flex-row items-baseline justify-between gap-3">
                <Text weight="medium" className="text-[15px] leading-5">
                  {w.label}
                </Text>
                <Text weight="bold" className="text-[22px] leading-7" style={styles.tabular}>
                  {`${Math.round(w.usedPercent)}%`}
                </Text>
              </View>
              <View
                style={styles.meter}
                accessibilityRole="progressbar"
                accessibilityLabel={`${w.label} used`}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(w.usedPercent) }}
              >
                <View
                  style={[
                    styles.meterFill,
                    {
                      width: `${Math.max(2, w.usedPercent)}%`,
                      backgroundColor: limitColor(w.usedPercent),
                    },
                  ]}
                />
              </View>
              <Text muted className="mt-2 text-[13px] leading-[18px]">
                {w.resetsAt ? resetLabel(w.resetsAt, now) : "Used of this window"}
              </Text>
            </View>
          ))
        ) : (
          <View className="flex-row items-center gap-2.5 px-4 py-4">
            {l ? null : <ActivityIndicator size="small" color={colors.textMuted} />}
            <Text muted className="flex-1 text-[14px] leading-5">
              {!l
                ? "Reading the plan’s limits…"
                : (l.error ?? "ChatGPT reported no limits for this plan.")}
            </Text>
          </View>
        )}
        <View style={styles.usageRow}>
          <View className="flex-1">
            <Text weight="medium" className="text-[15px] leading-5">
              This month
            </Text>
            <Text muted className="text-[13px] leading-[18px]">
              {usage
                ? `${usage.replies} ${usage.replies === 1 ? "reply" : "replies"}, ${formatTokens(tokens)} tokens`
                : "No replies yet"}
            </Text>
          </View>
          <Text weight="medium" className="text-[15px]">
            In your plan
          </Text>
        </View>
      </View>
      <View className="mt-2 gap-1.5 px-4">
        {l?.error && l.windows.length ? <Notice tone="danger">{l.error}</Notice> : null}
        <Footnote>
          {l
            ? `Updated ${timeAgo(l.checkedAt, now)}. Reads again after each reply. Codex and ChatGPT share these limits.`
            : "Replies use your ChatGPT plan, so there’s nothing to pay per token."}
        </Footnote>
      </View>
    </View>
  );
}

type ChatgptSession = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verifyUrl: string;
};

/** Codes from OpenAI last about 15 minutes. */
const CODE_LIFETIME_MS = 15 * 60_000;

/**
 * Signing in with a ChatGPT plan: OpenAI's device-code flow. The code is copied, OpenAI's page
 * opens in a browser sheet, and this polls until the code is approved there.
 */
function ChatgptSignIn({ onConnected }: { onConnected: () => void }) {
  const start = useApp((s) => s.chatgptStart);
  const poll = useApp((s) => s.chatgptPoll);
  const [session, setSession] = useState<ChatgptSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void start().then((r) => {
      if (!alive) return;
      if (r.ok) setSession(r);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [start, attempt]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const deadline = Date.now() + CODE_LIFETIME_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      if (Date.now() > deadline) {
        setError("The code expired. Get a new one and try again.");
        return;
      }
      const r = await poll(session.deviceAuthId, session.userCode);
      if (!alive) return;
      if (r.status === "connected") return onConnected();
      if (r.status === "error") return setError(r.error ?? "OpenAI didn’t finish the sign-in.");
      timer = setTimeout(() => void tick(), session.intervalMs);
    };
    timer = setTimeout(() => void tick(), session.intervalMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [session, poll, onConnected]);

  const retry = () => {
    setSession(null);
    setError(null);
    setCopied(false);
    setAttempt((n) => n + 1);
  };

  const openSignIn = async () => {
    if (!session) return;
    await Clipboard.setStringAsync(session.userCode);
    setCopied(true);
    await openLink(session.verifyUrl);
  };

  return (
    <>
      <Identity
        site="https://chatgpt.com"
        name="ChatGPT"
        detail="Use your Plus, Pro or Business plan instead of an API key"
      />
      <FormGroup
        footer={
          <>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Footnote>
              Paste the code on OpenAI’s page and approve it, then come back here. If OpenAI asks,
              allow device code sign-in in ChatGPT’s security settings.
            </Footnote>
          </>
        }
      >
        <View className="items-center gap-4 px-4 py-6">
          {session ? (
            <Text
              selectable
              accessibilityLabel={`Sign-in code ${session.userCode.split("").join(" ")}`}
              style={styles.code}
            >
              {session.userCode}
            </Text>
          ) : error ? null : (
            <ActivityIndicator color={colors.textMuted} />
          )}
          {error ? (
            <ActionButton label="Get a new code" icon="refresh" onPress={retry} />
          ) : (
            <ActionButton
              label={copied ? "Open OpenAI again" : "Copy code and sign in"}
              icon="open-outline"
              disabled={!session}
              onPress={() => void openSignIn()}
            />
          )}
          {session && !error ? (
            <View accessibilityLiveRegion="polite" className="flex-row items-center gap-2">
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text muted className="text-[13px]">
                {copied ? "Code copied. Waiting for you to approve it…" : "Waiting for approval…"}
              </Text>
            </View>
          ) : null}
        </View>
      </FormGroup>
    </>
  );
}

/**
 * The key's balance, read again while the sheet is open and after every reply, and what replies
 * from this app spent through the provider this month.
 */
function ProviderBalance({ provider, active }: { provider: Provider; active: boolean }) {
  const checkBalance = useApp((s) => s.checkBalance);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const id = provider.providerId;

  useEffect(() => {
    if (!active) return;
    void checkBalance(id);
    const poll = setInterval(() => void checkBalance(id), BALANCE_POLL_MS);
    // "Updated 2 min ago" keeps counting between reads.
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [active, id, checkBalance]);

  const refresh = async () => {
    setBusy(true);
    await checkBalance(id, true);
    setBusy(false);
  };

  if (provider.subscription)
    return (
      <PlanLimits provider={provider} now={now} busy={busy} onRefresh={() => void refresh()} />
    );

  const b = provider.balance;
  const usage = monthUsage(provider, now);
  const fraction = balanceFraction(provider);
  const figure = b && b.status !== "unsupported" ? (b.remaining ?? b.used ?? null) : null;
  const meterColor =
    fraction === null || fraction >= 0.2
      ? colors.success
      : fraction >= 0.05
        ? colors.warning
        : colors.danger;
  const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;
  // Priced replies give the spend directly. An endpoint that publishes no prices (most resellers)
  // is measured by how far its balance fell instead.
  const fromBalance = !usage?.costUsd && (usage?.balanceSpent ?? 0) > 0;
  const spendLabel = usage?.costUsd
    ? formatSpend(usage.costUsd)
    : fromBalance
      ? formatAmount(usage!.balanceSpent!, b?.currency)
      : usage && usage.unpriced > 0
        ? "Not published"
        : formatSpend(0);
  const spendNote = fromBalance
    ? "Spend is how far the balance fell this month, so it includes use of this key outside the app."
    : usage && usage.unpriced > 0 && !usage.costUsd
      ? b && figure !== null
        ? `${hostOf(provider.baseUrl)} doesn’t publish model prices. Spend shows here as the balance goes down.`
        : `${hostOf(provider.baseUrl)} doesn’t publish model prices or a balance, so spend can’t be counted.`
      : usage && usage.unpriced > 0
        ? "Models without a published price aren’t in the total."
        : null;

  return (
    <View className="mb-6">
      <View className="mb-2 flex-row items-center justify-between px-4">
        <Text weight="medium" muted className="text-[13px]">
          Balance
        </Text>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Refresh balance"
          disabled={busy}
          hitSlop={8}
          onPress={() => void refresh()}
          className="flex-row items-center gap-1.5"
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primaryStrong} />
          ) : (
            <Icon name="refresh" size={14} color={colors.primaryStrong} />
          )}
          <Text weight="medium" className="text-[13px] text-primary-strong">
            Refresh
          </Text>
        </Tap>
      </View>
      <View style={styles.group}>
        {b && figure !== null ? (
          <View className="px-4 pt-4 pb-4" accessibilityLiveRegion="polite">
            <Text
              weight="bold"
              className="text-[34px] leading-[40px]"
              style={styles.tabular}
              numberOfLines={1}
            >
              {formatAmount(figure, b.currency)}
            </Text>
            <Text muted className="text-[13px] leading-[18px]">
              {b.remaining === undefined
                ? "Used on this key, which has no limit"
                : b.total !== undefined && b.remaining < b.total
                  ? `Left of ${formatAmount(b.total, b.currency)}`
                  : "Left on this account"}
            </Text>
            {fraction !== null ? (
              <View
                style={styles.meter}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
              >
                <View
                  style={[
                    styles.meterFill,
                    { width: `${fraction * 100}%`, backgroundColor: meterColor },
                  ]}
                />
              </View>
            ) : null}
          </View>
        ) : (
          <View className="flex-row items-center gap-2.5 px-4 py-4">
            {b ? null : <ActivityIndicator size="small" color={colors.textMuted} />}
            <Text muted className="flex-1 text-[14px] leading-5">
              {!b
                ? "Reading the balance…"
                : b.status === "unsupported"
                  ? `${hostOf(provider.baseUrl)} doesn’t report a balance to API keys. Check it on the provider’s site.`
                  : (b.error ?? "Couldn’t read the balance.")}
            </Text>
          </View>
        )}
        <View style={styles.usageRow}>
          <View className="flex-1">
            <Text weight="medium" className="text-[15px] leading-5">
              This month
            </Text>
            <Text muted className="text-[13px] leading-[18px]">
              {usage
                ? `${usage.replies} ${usage.replies === 1 ? "reply" : "replies"}, ${formatTokens(tokens)} tokens`
                : "No replies yet"}
            </Text>
          </View>
          <Text weight="medium" className="text-[15px]" style={styles.tabular}>
            {spendLabel}
          </Text>
        </View>
      </View>
      <View className="mt-2 gap-1.5 px-4">
        {b?.status === "error" && figure !== null ? (
          <Notice tone="danger">{b.error ?? "Couldn’t read the balance."}</Notice>
        ) : null}
        <Footnote>
          {b && figure !== null
            ? `Updated ${timeAgo(b.checkedAt, now)}. Reads again after each reply.`
            : "This month counts replies sent from this app."}
          {spendNote ? ` ${spendNote}` : ""}
        </Footnote>
      </View>
    </View>
  );
}

/** A provider's models: refresh, search, and each model's capability profile. */
function ProviderModels({ providerId }: { providerId: string }) {
  const models = useApp((s) => s.models);
  const refresh = useApp((s) => s.refreshProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const all = models.filter((m) => m.providerId === providerId);
  const q = filter.trim().toLowerCase();
  const matching = q ? all.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(q)) : all;
  const list = matching.slice(0, 60);

  const run = async () => {
    setBusy(true);
    setError(null);
    const res = await refresh(providerId);
    setBusy(false);
    if (!res.ok) setError(res.error ?? "Couldn't fetch models.");
  };

  return (
    <View className="mb-6">
      <View className="mb-2 flex-row items-center justify-between px-4">
        <Text weight="medium" muted className="text-[13px]">
          Models
        </Text>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Refresh models"
          disabled={busy}
          hitSlop={8}
          onPress={() => void run()}
          className="flex-row items-center gap-1.5"
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primaryStrong} />
          ) : (
            <Icon name="refresh" size={14} color={colors.primaryStrong} />
          )}
          <Text weight="medium" className="text-[13px] text-primary-strong">
            Refresh
          </Text>
        </Tap>
      </View>
      {all.length > 20 ? (
        <View style={styles.search}>
          <Icon name="search" size={15} color={colors.textFaint} />
          <TextInput
            value={filter}
            onChangeText={setFilter}
            placeholder={`Search ${all.length} models`}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search models"
            style={[styles.input, { paddingVertical: 10 }]}
          />
        </View>
      ) : null}
      {list.length === 0 ? (
        <View className="px-4">
          <Footnote>
            {all.length
              ? "No models match."
              : "No models yet. Refresh to load the endpoint’s /models list."}
          </Footnote>
        </View>
      ) : (
        <View style={styles.group}>
          {list.map((m, i) => {
            const ref = modelRef(m);
            const isOpen = expanded === ref;
            return (
              <View key={ref} className="px-4 py-3">
                <Tap
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isOpen }}
                  onPress={() => setExpanded(isOpen ? null : ref)}
                  className="flex-row items-center gap-2"
                >
                  <Text weight="medium" className="flex-1 text-[15px]" numberOfLines={1}>
                    {m.name}
                  </Text>
                  {m.profile.source === "manual" ? <Pill label="Manual" tone="primary" /> : null}
                  {m.profile.confidence < 0.8 ? <Pill label="Unverified" tone="warning" /> : null}
                  <Icon
                    name={isOpen ? "chevron-up" : "chevron-down"}
                    size={15}
                    color={colors.textFaint}
                  />
                </Tap>
                {isOpen ? <ModelProfile model={m} /> : null}
                {i < list.length - 1 ? <Divider /> : null}
              </View>
            );
          })}
        </View>
      )}
      {matching.length > list.length ? (
        <View className="mt-2 px-4">
          <Footnote>{`Showing ${list.length} of ${matching.length}. Search to find the rest.`}</Footnote>
        </View>
      ) : null}
      {error ? (
        <View className="mt-2 px-4">
          <Notice tone="danger">{error}</Notice>
        </View>
      ) : null}
    </View>
  );
}

const featureLabels: { key: keyof CapabilityProfile["features"]; label: string }[] = [
  { key: "vision", label: "Vision" },
  { key: "tools", label: "Tool calls" },
  { key: "streaming", label: "Streaming" },
  { key: "reasoningText", label: "Reasoning text" },
  { key: "webSearch", label: "Web search" },
  { key: "audio", label: "Audio" },
];

/** Capability profile viewer with probes and manual overrides (PRD §3.5). */
function ModelProfile({ model }: { model: Model }) {
  const overrideProfile = useApp((s) => s.overrideProfile);
  const probe = useApp((s) => s.runProbes);
  const cap = useApp((s) => s.settings.probeSpendCapUsd);
  const showToast = useApp((s) => s.showToast);
  const [probing, setProbing] = useState<"idle" | "confirm" | "running">("idle");
  const p = model.profile;
  const ref = modelRef(model);

  const runProbes = async () => {
    setProbing("running");
    const findings = await probe(ref);
    setProbing("idle");
    if (findings.length) showToast(`${model.name}: ${findings.slice(0, 2).join(" ")}`);
  };

  return (
    <View className="gap-3 pb-1 pt-2">
      <View className="gap-1.5">
        <Text muted className="text-xs">
          Reasoning
        </Text>
        {p.reasoning.style === "none" ? (
          <Text className="text-sm">
            Not supported. The Thinking control is hidden for this model.
          </Text>
        ) : (
          <>
            <Text className="text-sm">
              {p.reasoning.style === "effort"
                ? "Effort levels"
                : p.reasoning.style === "budget"
                  ? "Token budget"
                  : "On or off"}{" "}
              via{" "}
              <Text weight="bold" className="text-sm">
                {p.reasoning.field}
              </Text>
            </Text>
            <View className="flex-row flex-wrap gap-1">
              {p.reasoning.levels.map((l) => (
                <Pill
                  key={l}
                  label={
                    p.reasoning.budgets?.[l]
                      ? `${l} ${(p.reasoning.budgets[l] / 1024).toFixed(0)}k`
                      : l
                  }
                  tone={l === p.reasoning.defaultLevel ? "primary" : "neutral"}
                />
              ))}
            </View>
          </>
        )}
      </View>

      <View className="gap-1.5">
        <Text muted className="text-xs">
          Features (tap to override)
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          {featureLabels.map((f) => {
            const on = p.features[f.key];
            return (
              <Tap
                key={f.key}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                onPress={() =>
                  overrideProfile(ref, {
                    features: { ...p.features, [f.key]: !on },
                    source: "manual",
                    confidence: 1,
                  })
                }
                className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${on ? "bg-[rgba(23,201,100,0.12)]" : "bg-raised"}`}
              >
                <Icon
                  name={on ? "checkmark" : "close"}
                  size={12}
                  color={on ? colors.success : colors.textFaint}
                />
                <Text
                  weight="medium"
                  className="text-xs"
                  style={{ color: on ? colors.success : colors.textMuted }}
                >
                  {f.label}
                </Text>
              </Tap>
            );
          })}
        </View>
      </View>

      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-1">
          <View className="h-1.5 overflow-hidden rounded-full bg-raised">
            <View
              className="h-full rounded-full"
              style={{
                width: `${p.confidence * 100}%`,
                backgroundColor:
                  p.confidence >= 0.85
                    ? colors.success
                    : p.confidence >= 0.5
                      ? colors.warning
                      : colors.danger,
              }}
            />
          </View>
          <Text className="text-xs text-ink-faint">
            {Math.round(p.confidence * 100)}% confidence, from {p.source}, checked{" "}
            {new Date(p.lastVerified).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
            , v{p.version}
          </Text>
        </View>
        {probing === "running" ? (
          <Spinner size="sm" />
        ) : (
          <ActionButton
            size="sm"
            variant="secondary"
            label="Run probes"
            onPress={() => setProbing("confirm")}
          />
        )}
      </View>

      {probing === "confirm" ? (
        <View className="gap-2 rounded-2xl bg-raised p-3">
          <Text className="text-[13px] leading-[18px]">
            Sends a few tiny requests with no personal data, within your ${cap.toFixed(2)} probe
            cap. Every request is logged.
            {p.source === "manual" ? " Your manual overrides stay as they are." : ""}
          </Text>
          <View className="flex-row justify-end gap-2">
            <ActionButton
              size="sm"
              variant="ghost"
              label="Cancel"
              onPress={() => setProbing("idle")}
            />
            <ActionButton size="sm" label="Run" onPress={() => void runProbes()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

type Mode = "pick" | "new" | "edit" | "chatgpt";

/**
 * Add or edit a provider, laid out like iOS Mail's Add Account: pick a service from a list (no
 * keyboard), then a short form whose only required field for a known service is the key. The
 * confirm action lives in the sheet's toolbar, so the keyboard never covers it.
 */
export function ProviderSheet({
  open,
  onClose,
  providerId,
}: {
  open: boolean;
  onClose: () => void;
  providerId: string | null;
}) {
  const providers = useApp((s) => s.providers);
  const models = useApp((s) => s.models);
  const saveProvider = useApp((s) => s.saveProvider);
  const removeProvider = useApp((s) => s.removeProvider);
  const showToast = useApp((s) => s.showToast);

  const [mode, setMode] = useState<Mode>("pick");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<Draft>(blank);
  const [baseline, setBaseline] = useState<Draft>(blank);
  const [idTouched, setIdTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [motion, setMotion] = useState<"none" | "forward" | "back">("none");
  const nameRef = useRef<TextInput>(null);
  const urlRef = useRef<TextInput>(null);
  const keyRef = useRef<TextInput>(null);
  const idRef = useRef<TextInput>(null);

  const startEdit = (p: Provider) => {
    const d: Draft = {
      providerId: p.providerId,
      label: p.label,
      baseUrl: p.baseUrl,
      headers: p.headers.map((h) => ({ key: h.key, value: h.value })),
    };
    setMode("edit");
    setPreset(presetFor(p.baseUrl));
    setForm(d);
    setBaseline(d);
    setApiKey("");
    setError(null);
    setAdvanced(false);
    setIdTouched(true);
  };

  // Each opening starts fresh (adjust-state-during-render, no effect needed).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMotion("none");
      setSaving(false);
      const p = providers.find((x) => x.providerId === providerId);
      if (p) startEdit(p);
      else {
        setMode("pick");
        setPreset(null);
        setForm(blank);
        setBaseline(blank);
        setApiKey("");
        setError(null);
        setAdvanced(false);
        setIdTouched(false);
      }
    }
  }

  const fromList = providerId === null;
  const matchFor = (p: Preset) =>
    providers.find((x) => x.providerId === p.id || hostOf(x.baseUrl) === hostOf(p.baseUrl));
  const taken = (id: string) => providers.some((p) => p.providerId === id);
  const freeId = (base: string) => {
    if (!base) return "";
    let id = base;
    for (let n = 2; taken(id); n++) id = `${base.slice(0, 29)}-${n}`;
    return id;
  };
  const id =
    mode === "new" && !idTouched
      ? freeId(preset ? preset.id : slug(form.label) || slug(hostOf(form.baseUrl)))
      : form.providerId;
  const url = tidyUrl(form.baseUrl);
  const idProblem = !id
    ? null
    : !ID_RE.test(id)
      ? "IDs use lowercase letters, numbers, - or _, up to 32 characters."
      : mode === "new" && taken(id)
        ? "You already have a provider with this ID."
        : null;
  const valid = Boolean(id) && !idProblem && URL_RE.test(url);
  const key = apiKey.trim();
  const dirty =
    mode === "edit"
      ? Boolean(key) || !sameDraft(form, baseline)
      : mode === "new"
        ? Boolean(key || form.headers.length || (!preset && (form.label || form.baseUrl)))
        : false;
  const canSave = !saving && valid && (mode === "edit" ? dirty : preset ? Boolean(key) : true);
  const existing = mode === "edit" ? providers.find((p) => p.providerId === id) : undefined;
  const keyHint = existing?.keyHint && existing.keyHint !== "none" ? existing.keyHint : "";
  const count = models.filter((m) => m.providerId === id).length;

  const guard = (action: () => void) => {
    if (!dirty || saving) return action();
    confirmDestructive(
      mode === "new" ? "Discard this provider?" : "Discard your changes?",
      undefined,
      { cancel: "Keep editing", confirm: "Discard" },
      action
    );
  };

  const choose = (p: Preset | null) => {
    setMotion("forward");
    const match = p ? matchFor(p) : undefined;
    if (match) return startEdit(match);
    const d: Draft = p
      ? { providerId: "", label: p.label, baseUrl: p.baseUrl, headers: [] }
      : blank;
    setMode("new");
    setPreset(p);
    setForm(d);
    setBaseline(d);
    setApiKey("");
    setError(null);
    setAdvanced(false);
    setIdTouched(false);
  };

  const backToList = () => {
    Keyboard.dismiss();
    setMotion("back");
    setMode("pick");
    setPreset(null);
    setError(null);
  };

  const save = async () => {
    if (!canSave) return;
    Keyboard.dismiss();
    setSaving(true);
    setError(null);
    const draft: Draft = {
      providerId: id,
      label: form.label.trim() || preset?.label || id,
      baseUrl: url,
      headers: form.headers
        .map((h) => ({ key: h.key.trim(), value: h.value }))
        .filter((h) => h.key),
    };
    const res = await saveProvider(draft, key || undefined);
    setSaving(false);
    if (res.ok) return onClose();
    setError(res.error ?? "Couldn’t reach this endpoint.");
    if (res.saved && mode === "new") {
      // Stored with its key but not connected: carry on as an edit of the saved provider.
      setMotion("none");
      setMode("edit");
      setForm(draft);
      setBaseline(draft);
      setApiKey("");
      setIdTouched(true);
    }
  };

  const remove = () =>
    confirmDestructive(
      `Remove ${form.label || id}?`,
      `Its ${count} ${count === 1 ? "model leaves" : "models leave"} the model picker and the key is deleted from the server.`,
      { cancel: "Cancel", confirm: "Remove" },
      () => {
        removeProvider(id);
        showToast("Provider removed");
        onClose();
      }
    );

  const setKey = (t: string) => {
    setApiKey(cleanKey(t));
    setError(null);
  };

  const notice = saving ? (
    <Notice tone="busy">{`Connecting to ${hostOf(url)} and loading its models…`}</Notice>
  ) : error ? (
    <Notice tone="danger">{error}</Notice>
  ) : null;

  const keyRow = (
    <FieldRow
      label="API key"
      inputRef={keyRef}
      value={apiKey}
      onChangeText={setKey}
      placeholder={keyHint ? `Saved ${keyHint}` : preset ? "Paste your key" : "Optional"}
      secureTextEntry
      // An API key, not an account password: keeps iOS from offering to save it to Passwords.
      textContentType="oneTimeCode"
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      autoComplete="off"
      returnKeyType="go"
      onSubmitEditing={() => void save()}
      // A known service needs only its key, so the keyboard comes up with the step.
      autoFocus={mode === "new" && preset !== null}
      accessory={apiKey ? null : <PasteKey onPaste={setKey} />}
      last
    />
  );

  const nameRow = (
    <FieldRow
      label="Name"
      inputRef={nameRef}
      value={form.label}
      onChangeText={(label) => setForm({ ...form, label })}
      placeholder="Together AI"
      autoFocus={mode === "new" && preset === null}
      returnKeyType="next"
      submitBehavior="submit"
      onSubmitEditing={() => urlRef.current?.focus()}
    />
  );

  const urlRow = (
    <FieldRow
      label="URL"
      inputRef={urlRef}
      value={form.baseUrl}
      onChangeText={(baseUrl) => {
        setForm({ ...form, baseUrl });
        setError(null);
      }}
      onBlur={() => setForm((f) => ({ ...f, baseUrl: tidyUrl(f.baseUrl) }))}
      placeholder="api.together.xyz/v1"
      keyboardType="url"
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="next"
      submitBehavior="submit"
      onSubmitEditing={() => keyRef.current?.focus()}
    />
  );

  const advancedSection = (
    <>
      <Tap
        accessibilityRole="button"
        accessibilityState={{ expanded: advanced }}
        hitSlop={8}
        onPress={() => setAdvanced(!advanced)}
        className="mb-2 flex-row items-center gap-1.5 self-start px-4 py-1"
      >
        <Text weight="medium" muted className="text-[13px]">
          Advanced
        </Text>
        <Icon name={advanced ? "chevron-up" : "chevron-down"} size={13} color={colors.textMuted} />
      </Tap>
      {advanced ? (
        <FormGroup
          footer={
            <Footnote>
              {idProblem ??
                "Headers go with every request, for example HTTP-Referer for OpenRouter."}
            </Footnote>
          }
        >
          {mode === "new" && preset ? urlRow : null}
          <FieldRow
            label="ID"
            inputRef={idRef}
            value={id}
            editable={mode === "new"}
            onChangeText={(v) => {
              setIdTouched(true);
              setForm({ ...form, providerId: v.toLowerCase() });
            }}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {form.headers.map((h, i) => (
            <View key={i} style={styles.row}>
              <TextInput
                value={h.key}
                onChangeText={(k) =>
                  setForm({
                    ...form,
                    headers: form.headers.map((x, j) => (j === i ? { ...x, key: k } : x)),
                  })
                }
                placeholder="Header"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Header name"
                style={[styles.input, { flex: 1 }]}
              />
              <View style={styles.vrule} />
              <TextInput
                value={h.value}
                onChangeText={(value) =>
                  setForm({
                    ...form,
                    headers: form.headers.map((x, j) => (j === i ? { ...x, value } : x)),
                  })
                }
                placeholder="Value"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Header value"
                style={[styles.input, { flex: 1.4 }]}
              />
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Remove header"
                hitSlop={8}
                onPress={() =>
                  setForm({ ...form, headers: form.headers.filter((_, j) => j !== i) })
                }
              >
                <Icon name="remove-circle" size={20} color={colors.danger} />
              </Tap>
              <Divider />
            </View>
          ))}
          <Tap
            accessibilityRole="button"
            onPress={() => setForm({ ...form, headers: [...form.headers, { key: "", value: "" }] })}
            className="flex-row items-center gap-2.5 px-4 py-3.5"
          >
            <Icon name="add-circle" size={19} color={colors.primaryStrong} />
            <Text weight="medium" className="text-base text-primary-strong">
              Add header
            </Text>
          </Tap>
        </FormGroup>
      ) : null}
    </>
  );

  let body: ReactNode;
  if (mode === "pick") {
    const plan = providers.find((p) => p.subscription?.vendor === "chatgpt");
    body = (
      <>
        <Text weight="medium" muted className="mb-2 px-4 text-[13px]">
          Use a plan you pay for
        </Text>
        <FormGroup>
          <ListRow
            icon={<Favicon url="https://chatgpt.com" size={30} />}
            label="ChatGPT"
            detail={
              plan
                ? `Signed in${plan.subscription?.email ? ` as ${plan.subscription.email}` : ""}`
                : "Plus, Pro or Business"
            }
            last
            onPress={() => {
              setMotion("forward");
              if (plan) return startEdit(plan);
              setMode("chatgpt");
              setPreset(null);
              setError(null);
            }}
          />
        </FormGroup>
        <Text weight="medium" muted className="mb-2 px-4 text-[13px]">
          Use an API key
        </Text>
        <FormGroup>
          {PRESETS.map((p, i) => {
            const added = matchFor(p);
            return (
              <ListRow
                key={p.id}
                icon={<Favicon url={`https://${p.site}`} size={30} />}
                label={p.label}
                right={
                  added ? (
                    <View className="flex-row items-center gap-1.5">
                      <View
                        style={[
                          styles.dot,
                          {
                            backgroundColor:
                              added.status === "connected" ? colors.success : colors.danger,
                          },
                        ]}
                      />
                      <Text muted className="text-[13px]">
                        Added
                      </Text>
                    </View>
                  ) : null
                }
                last={i === PRESETS.length - 1}
                onPress={() => choose(p)}
              />
            );
          })}
        </FormGroup>
        <FormGroup
          footer={
            <Footnote>
              Keys are stored encrypted on the server, and requests go through it rather than
              straight from this phone.
            </Footnote>
          }
        >
          <ListRow
            icon={
              <View style={styles.plus}>
                <Icon name="add" size={18} color={colors.text} />
              </View>
            }
            label="Other endpoint"
            detail="Any OpenAI-compatible URL"
            last
            onPress={() => choose(null)}
          />
        </FormGroup>
      </>
    );
  } else if (mode === "chatgpt") {
    body = (
      <ChatgptSignIn
        onConnected={() => {
          showToast("Signed in to ChatGPT");
          onClose();
        }}
      />
    );
  } else if (existing?.subscription) {
    const connected = existing.status === "connected";
    const signOut = () =>
      Alert.alert(
        "Sign out of ChatGPT?",
        "Its models leave the model picker. You can sign in again any time.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Sign out",
            style: "destructive",
            onPress: () => {
              removeProvider(id);
              showToast("Signed out of ChatGPT");
              onClose();
            },
          },
        ]
      );
    body = (
      <>
        <Identity
          site="https://chatgpt.com"
          name="ChatGPT"
          detail={
            connected
              ? `Signed in${existing.subscription.email ? ` as ${existing.subscription.email}` : ""}${existing.subscription.plan ? `, ${existing.subscription.plan} plan` : ""}`
              : existing.status === "checking"
                ? "Checking…"
                : (existing.lastError ?? "Not connected")
          }
          dot={connected ? colors.success : colors.danger}
        />
        <ProviderBalance provider={existing} active={open} />
        <ProviderModels providerId={id} />
        <FormGroup>
          <ListRow label="Sign out" danger last onPress={signOut} />
        </FormGroup>
      </>
    );
  } else if (mode === "new" && preset) {
    body = (
      <>
        <Identity site={`https://${preset.site}`} name={preset.label} detail={hostOf(url)} />
        <FormGroup
          footer={
            <>
              {notice}
              <Tap
                accessibilityRole="link"
                hitSlop={6}
                onPress={() => void openLink(preset.keys)}
                className="flex-row items-center gap-1 self-start"
              >
                <Text weight="medium" className="text-[13px]" style={{ color: colors.link }}>
                  {`Get a key at ${hostOf(preset.keys)}`}
                </Text>
                <Icon name="open-outline" size={13} color={colors.link} />
              </Tap>
              <Footnote>Stored encrypted on the server and never sent back to this phone.</Footnote>
            </>
          }
        >
          {keyRow}
        </FormGroup>
        {advancedSection}
      </>
    );
  } else if (mode === "new") {
    body = (
      <>
        <FormGroup
          footer={
            <>
              {notice}
              <Footnote>
                Works with any server that speaks the OpenAI API, including its /models list.
              </Footnote>
            </>
          }
        >
          {nameRow}
          {urlRow}
          {keyRow}
        </FormGroup>
        {advancedSection}
      </>
    );
  } else {
    const connected = existing?.status === "connected";
    body = (
      <>
        <Identity
          site={preset ? `https://${preset.site}` : url}
          name={form.label || id}
          detail={
            connected
              ? `Connected, ${count} ${count === 1 ? "model" : "models"}`
              : existing?.status === "checking"
                ? "Checking…"
                : // The inline notice already carries a fresh error.
                  ((error ? null : existing?.lastError) ?? "Not connected")
          }
          dot={connected ? colors.success : colors.danger}
        />
        {existing ? <ProviderBalance provider={existing} active={open} /> : null}
        <FormGroup footer={notice}>
          {nameRow}
          {urlRow}
          {keyRow}
        </FormGroup>
        <ProviderModels providerId={id} />
        {advancedSection}
        <FormGroup>
          <ListRow label="Remove provider" danger last onPress={remove} />
        </FormGroup>
      </>
    );
  }

  const step =
    mode === "edit"
      ? `edit:${id}`
      : mode === "chatgpt"
        ? "chatgpt"
        : `${mode}:${preset?.id ?? "other"}`;
  const nothingToSave = mode === "pick" || mode === "chatgpt" || Boolean(existing?.subscription);
  const entering =
    motion === "forward"
      ? SlideInRight.duration(260)
      : motion === "back"
        ? SlideInLeft.duration(260)
        : undefined;

  return (
    <FormSheet
      open={open}
      onClose={() => guard(onClose)}
      page={step}
      title={
        mode === "pick"
          ? "Add provider"
          : mode === "chatgpt"
            ? "ChatGPT"
            : mode === "new"
              ? (preset?.label ?? "Other endpoint")
              : form.label || id
      }
      leading={
        fromList && mode !== "pick"
          ? { label: "Back", icon: "chevron-back", onPress: () => guard(backToList) }
          : { label: "Close", icon: "close", onPress: () => guard(onClose) }
      }
      confirm={
        nothingToSave
          ? undefined
          : {
              label: mode === "new" ? "Connect" : "Save",
              icon: "checkmark",
              onPress: () => void save(),
              disabled: !canSave,
              busy: saving,
            }
      }
    >
      <Animated.View key={step} entering={entering}>
        {body}
      </Animated.View>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  group: { backgroundColor: GROUP_BG, borderRadius: LIST_RADIUS, overflow: "hidden" },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 16,
    paddingRight: 12,
  },
  rowLabel: { width: 70, fontSize: 16, color: colors.text },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 15,
  },
  listRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  divider: {
    position: "absolute",
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  vrule: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    marginVertical: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  code: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 38,
    letterSpacing: 3,
    color: colors.text,
  },
  topRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.10)" },
  tabular: { fontVariant: ["tabular-nums"] },
  meter: {
    height: 6,
    marginTop: 14,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: colors.raisedHigh,
  },
  meterFill: { height: "100%", borderRadius: 3 },
  usageRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.10)",
  },
  plus: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.raisedHigh,
    alignItems: "center",
    justifyContent: "center",
  },
  paste: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    backgroundColor: colors.raisedHigh,
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderRadius: 14,
    backgroundColor: GROUP_BG,
  },
});
