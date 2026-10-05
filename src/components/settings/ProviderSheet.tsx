import { Spinner } from "heroui-native";
import { useState, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, Pill } from "@/genui/kit";
import { modelRef } from "@/lib/models";
import { useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import type { CapabilityProfile, Model, Provider } from "@/lib/types";

const field = {
  fontFamily: fonts.body,
  fontSize: 16,
  color: colors.text,
  backgroundColor: colors.raised,
  borderRadius: 14,
  paddingHorizontal: 14,
  paddingVertical: 11,
} as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text weight="medium" muted className="text-[13px]">
        {label}
      </Text>
      {children}
      {hint ? <Text className="text-xs leading-4 text-ink-faint">{hint}</Text> : null}
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
  const refreshProvider = useApp((s) => s.refreshProvider);
  const removeProvider = useApp((s) => s.removeProvider);
  const showToast = useApp((s) => s.showToast);
  const existing = providers.find((p) => p.providerId === providerId);

  const [form, setForm] = useState<Provider>(
    existing ?? {
      providerId: "",
      label: "",
      baseUrl: "",
      keyHint: "",
      headers: [],
      status: "checking",
    }
  );
  const [apiKey, setApiKey] = useState("");
  const [fetching, setFetching] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Reset the form each time the sheet opens (adjust-state-during-render, no effect needed).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(
        existing ?? {
          providerId: "",
          label: "",
          baseUrl: "",
          keyHint: "",
          headers: [],
          status: "checking",
        }
      );
      setApiKey("");
      setExpanded(null);
    }
  }

  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const all = models.filter((m) => m.providerId === form.providerId && form.providerId);
  const q = filter.trim().toLowerCase();
  const matching = q ? all.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(q)) : all;
  const list = matching.slice(0, 60);
  const valid =
    /^[a-z0-9][a-z0-9_-]*$/.test(form.providerId) && /^https?:\/\/.+/.test(form.baseUrl);

  const input = () => ({
    providerId: form.providerId,
    label: form.label || form.providerId,
    baseUrl: form.baseUrl,
    headers: form.headers.filter((h) => h.key.trim()),
  });

  const fetchModels = async () => {
    if (!valid) return;
    setFetching(true);
    if (existing) await refreshProvider(existing.providerId);
    else await saveProvider(input(), apiKey || undefined);
    setFetching(false);
  };

  const save = async () => {
    setSaving(true);
    const ok = await saveProvider(input(), apiKey || undefined);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={existing ? existing.label : "Add provider"}
      subtitle="Any OpenAI-compatible endpoint. Calls are proxied through the server, never sent from the phone."
      footer={
        <View className="flex-row gap-2">
          {existing ? (
            <View className="flex-1">
              <ActionButton
                variant="danger-soft"
                label="Remove"
                onPress={() => {
                  removeProvider(existing.providerId);
                  showToast("Provider removed");
                  onClose();
                }}
              />
            </View>
          ) : null}
          <View className="flex-1">
            <ActionButton
              label={saving ? "Connecting…" : "Save"}
              disabled={!valid || saving}
              onPress={() => void save()}
            />
          </View>
        </View>
      }
    >
      <View className="gap-4">
        <Field label="Provider ID" hint="Lowercase letters, numbers and dashes.">
          <TextInput
            editable={!existing}
            value={form.providerId}
            onChangeText={(providerId) =>
              setForm({ ...form, providerId: providerId.toLowerCase() })
            }
            placeholder="together"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            accessibilityLabel="Provider ID"
            style={[field, !existing ? null : { opacity: 0.6 }]}
          />
        </Field>
        <Field label="Name">
          <TextInput
            value={form.label}
            onChangeText={(label) => setForm({ ...form, label })}
            placeholder="Together AI"
            placeholderTextColor={colors.textFaint}
            accessibilityLabel="Name"
            style={field}
          />
        </Field>
        <Field label="Base URL">
          <TextInput
            value={form.baseUrl}
            onChangeText={(baseUrl) => setForm({ ...form, baseUrl })}
            placeholder="https://api.together.xyz/v1"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            keyboardType="url"
            accessibilityLabel="Base URL"
            style={field}
          />
        </Field>
        <Field
          label="API key"
          hint="Encrypted at rest on the server and never sent back to this device."
        >
          <TextInput
            value={apiKey}
            onChangeText={(t) => setApiKey(t.replace(/\s+/g, ""))}
            placeholder={
              form.keyHint && form.keyHint !== "none" ? `Saved key ${form.keyHint}` : "sk-…"
            }
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            accessibilityLabel="API key"
            style={field}
          />
        </Field>
        <Field label="Extra headers">
          <View className="gap-2">
            {form.headers.map((h, i) => (
              <View key={i} className="flex-row items-center gap-2">
                <TextInput
                  value={h.key}
                  onChangeText={(key) =>
                    setForm({
                      ...form,
                      headers: form.headers.map((x, j) => (j === i ? { ...x, key } : x)),
                    })
                  }
                  placeholder="Header"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  accessibilityLabel="Header name"
                  style={[field, { flex: 1, minWidth: 0, width: 0 }]}
                />
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
                  accessibilityLabel="Header value"
                  style={[field, { flex: 1.4, minWidth: 0, width: 0 }]}
                />
                <Tap
                  accessibilityLabel="Remove header"
                  onPress={() =>
                    setForm({ ...form, headers: form.headers.filter((_, j) => j !== i) })
                  }
                >
                  <Icon name="remove-circle" size={22} color={colors.textFaint} />
                </Tap>
              </View>
            ))}
            <Tap
              onPress={() =>
                setForm({ ...form, headers: [...form.headers, { key: "", value: "" }] })
              }
              className="flex-row items-center gap-1.5 self-start py-1"
            >
              <Icon name="add-circle" size={18} color={colors.primary} />
              <Text weight="medium" className="text-sm text-primary">
                Add header
              </Text>
            </Tap>
          </View>
        </Field>

        <View className="gap-2">
          <View className="flex-row items-center justify-between">
            <Text weight="bold" className="text-base">
              Models
            </Text>
            {fetching ? (
              <Spinner size="sm" />
            ) : (
              <ActionButton
                size="sm"
                variant="secondary"
                icon="refresh"
                label="Fetch models"
                disabled={!valid}
                onPress={() => void fetchModels()}
              />
            )}
          </View>
          {all.length > 20 ? (
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder={`Search ${all.length} models`}
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              accessibilityLabel="Search models"
              style={field}
            />
          ) : null}
          {list.length === 0 ? (
            <Text muted className="text-[13px]">
              {all.length
                ? "No models match."
                : "No models yet. Fetch them from the endpoint’s /models list."}
            </Text>
          ) : (
            <View className="overflow-hidden rounded-3xl bg-card">
              {list.map((m, i) => {
                const ref = modelRef(m);
                const isOpen = expanded === ref;
                return (
                  <View
                    key={ref}
                    className={`px-4 py-3 ${i < list.length - 1 ? "border-b border-hairline" : ""}`}
                  >
                    <Tap
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isOpen }}
                      onPress={() => setExpanded(isOpen ? null : ref)}
                      className="flex-row items-center gap-2"
                    >
                      <Text weight="bold" className="flex-1 text-[15px]">
                        {m.name}
                      </Text>
                      {m.profile.source === "manual" ? (
                        <Pill label="Manual" tone="primary" />
                      ) : null}
                      {m.profile.confidence < 0.8 ? (
                        <Pill label="Unverified" tone="warning" />
                      ) : null}
                      <Icon
                        name={isOpen ? "chevron-up" : "chevron-down"}
                        size={16}
                        color={colors.textFaint}
                      />
                    </Tap>
                    {isOpen ? <ModelProfile model={m} /> : null}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </View>
    </Sheet>
  );
}
