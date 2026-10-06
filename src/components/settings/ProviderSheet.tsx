import { Spinner } from "heroui-native";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, Pill } from "@/genui/kit";
import { modelRef } from "@/lib/models";
import { useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import type { CapabilityProfile, Model, Provider } from "@/lib/types";
import * as Clipboard from "expo-clipboard";
import { useRef, useState, ReactNode, RefObject } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  TextInputProps,
} from "react-native";
import Animated, { SlideInLeft, SlideInRight } from "react-native-reanimated";
import { Favicon } from "@/components/ui/Favicon";
import { FormSheet, GROUP_BG } from "@/components/ui/FormSheet";

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

type Mode = "pick" | "new" | "edit";

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
    Alert.alert(mode === "new" ? "Discard this provider?" : "Discard your changes?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: action },
    ]);
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
      headers: form.headers.filter((h) => h.key.trim()),
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
    Alert.alert(
      `Remove ${form.label || id}?`,
      `Its ${count} ${count === 1 ? "model leaves" : "models leave"} the model picker and the key is deleted from the server.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            removeProvider(id);
            showToast("Provider removed");
            onClose();
          },
        },
      ]
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
    body = (
      <>
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
                onPress={() => void Linking.openURL(preset.keys)}
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

  const step = mode === "edit" ? `edit:${id}` : `${mode}:${preset?.id ?? "other"}`;
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
        mode === "pick"
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
  group: { backgroundColor: GROUP_BG, borderRadius: 22, overflow: "hidden" },
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
