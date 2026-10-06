import { Switch } from "heroui-native";
import { useState, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { ProviderSheet } from "@/components/settings/ProviderSheet";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Group, Page } from "@/components/ui/Page";
import { Segmented } from "@/components/ui/Segmented";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { findModel, useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import { InstructionsSheet } from "@/components/settings/InstructionsSheet";

function Row({
  icon,
  label,
  detail,
  value,
  onPress,
  right,
  last,
}: {
  icon?: IconName;
  label: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  right?: ReactNode;
  last?: boolean;
}) {
  const body = (
    <View
      className={`flex-row items-center gap-3 px-4 py-3.5 ${last ? "" : "border-b border-hairline"}`}
    >
      {icon ? <Icon name={icon} size={19} color={colors.textMuted} /> : null}
      <View className="flex-1">
        <Text weight="medium" className="text-base">
          {label}
        </Text>
        {detail ? (
          <Text muted className="text-[13px] leading-[18px]" numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text muted className="max-w-[42%] text-[15px]" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress ? <Icon name="chevron-forward" size={16} color={colors.textFaint} /> : null}
    </View>
  );
  return onPress ? (
    <Tap accessibilityRole="button" onPress={onPress}>
      {body}
    </Tap>
  ) : (
    body
  );
}

function Stack({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <View className={`gap-2 px-4 py-3.5 ${last ? "" : "border-b border-hairline"}`}>
      <Text weight="medium" className="text-base">
        {label}
      </Text>
      {children}
    </View>
  );
}

export default function SettingsScreen() {
  const providers = useApp((s) => s.providers);
  const models = useApp((s) => s.models);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const [providerSheet, setProviderSheet] = useState<{ id: string | null } | null>(null);
  const [picker, setPicker] = useState<"default" | "research" | null>(null);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const instructions = settings.customInstructions.trim();

  return (
    <View className="flex-1 bg-background">
      <Page title="Settings">
        <Group
          label="Providers"
          footer="Bring your own OpenAI-compatible endpoints. Keys stay on the server."
        >
          {providers.map((p) => {
            const n = models.filter((m) => m.providerId === p.providerId).length;
            return (
              <Row
                key={p.providerId}
                label={p.label}
                detail={`${p.baseUrl.replace(/^https?:\/\//, "")}, ${n} ${n === 1 ? "model" : "models"}`}
                right={
                  <View
                    className={`h-2 w-2 rounded-full ${p.status === "connected" ? "bg-success" : "bg-danger"}`}
                  />
                }
                onPress={() => setProviderSheet({ id: p.providerId })}
              />
            );
          })}
          <Tap
            accessibilityRole="button"
            onPress={() => setProviderSheet({ id: null })}
            className="flex-row items-center gap-3 px-4 py-3.5"
          >
            <Icon name="add-circle" size={19} color={colors.primary} />
            <Text weight="medium" className="text-base text-primary">
              Add provider
            </Text>
          </Tap>
        </Group>

        <Group label="Models">
          <Row
            label="Default model"
            value={findModel(models, settings.defaultModelRef).name}
            onPress={() => setPicker("default")}
          />
          <Row
            label="Research model"
            detail="Writes the final report in Deep Research"
            value={
              settings.researchModelRef
                ? findModel(models, settings.researchModelRef).name
                : "Same as chat"
            }
            onPress={() => setPicker("research")}
            last
          />
        </Group>

        <Group
          label="Custom instructions"
          footer="Added to every conversation, separate from memory."
        >
          <Tap
            accessibilityRole="button"
            accessibilityLabel={instructions ? "Custom instructions" : "Add custom instructions"}
            accessibilityHint="Opens an editor"
            onPress={() => setEditingInstructions(true)}
            className="flex-row items-start gap-3 px-4 py-3.5"
          >
            <Text
              className="flex-1 text-[15px] leading-[21px]"
              style={instructions ? undefined : { color: colors.textFaint }}
              numberOfLines={6}
            >
              {instructions || "How should Anomaly respond? What should it know about you?"}
            </Text>
            <Icon
              name={instructions ? "chevron-forward" : "add-circle"}
              size={instructions ? 16 : 19}
              color={instructions ? colors.textFaint : colors.primary}
            />
          </Tap>
        </Group>

        <Group
          label="Agents and web"
          footer="Asking for sub-agents in a message always overrides the setting."
        >
          <Stack label="Sub-agents">
            <Segmented
              accessibilityLabel="Sub-agents"
              value={settings.subagentMode}
              onChange={(subagentMode) => update({ subagentMode })}
              options={[
                { value: "off", label: "Off" },
                { value: "auto", label: "Auto" },
                { value: "offer", label: "Always offer" },
              ]}
            />
          </Stack>
          <Stack label="Web access">
            <Segmented
              accessibilityLabel="Web access"
              value={settings.webMode}
              onChange={(webMode) => update({ webMode })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "native", label: "Native only" },
                { value: "app", label: "App tools" },
              ]}
            />
            <Text muted className="text-[13px] leading-[18px]">
              {settings.webMode === "auto"
                ? "Uses the model's own web search when it has one, and Anomaly's search tools so every model can browse."
                : settings.webMode === "native"
                  ? "Only the model's built-in search. Costs go to your key; models without it can't browse."
                  : "Anomaly always fetches pages itself, even when the model could search."}
            </Text>
          </Stack>
          <Stack label="Search fallback" last>
            <Segmented
              accessibilityLabel="Search fallback"
              value={settings.searchProvider}
              onChange={(searchProvider) => update({ searchProvider })}
              options={[
                { value: "none", label: "Default" },
                { value: "brave", label: "Brave" },
                { value: "tavily", label: "Tavily" },
                { value: "searxng", label: "SearXNG" },
              ]}
            />
            {settings.searchProvider !== "none" ? (
              <TextInput
                value={settings.searchKeyHint}
                onChangeText={(searchKeyHint) => update({ searchKeyHint })}
                placeholder={
                  settings.searchProvider === "searxng"
                    ? "Your SearXNG URL (blank uses the built-in pool)"
                    : "API key"
                }
                placeholderTextColor={colors.textFaint}
                secureTextEntry={settings.searchProvider !== "searxng"}
                textContentType="oneTimeCode"
                autoCapitalize="none"
                accessibilityLabel="Search provider key or URL"
                style={{
                  fontFamily: fonts.body,
                  fontSize: 15,
                  color: colors.text,
                  backgroundColor: colors.raised,
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              />
            ) : (
              <Text muted className="text-[13px]">
                Built-in SearXNG pool, then Exa and DuckDuckGo. No key needed.
              </Text>
            )}
          </Stack>
        </Group>

        <Group label="Voice">
          <Stack label="Speech to text">
            <Segmented
              accessibilityLabel="Speech to text"
              value={settings.voiceInput}
              onChange={(voiceInput) => update({ voiceInput })}
              options={[
                { value: "device", label: "On device" },
                { value: "endpoint", label: "My endpoint" },
              ]}
            />
          </Stack>
          <Stack label="Text to speech">
            <Segmented
              accessibilityLabel="Text to speech"
              value={settings.voiceOutput}
              onChange={(voiceOutput) => update({ voiceOutput })}
              options={[
                { value: "device", label: "Device voice" },
                { value: "endpoint", label: "My endpoint" },
              ]}
            />
          </Stack>
          <Row
            label="Read replies aloud"
            detail="Components are summarised in a sentence."
            right={
              <Switch
                accessibilityLabel="Read replies aloud"
                isSelected={settings.readRepliesAloud}
                onSelectedChange={(readRepliesAloud) => update({ readRepliesAloud })}
              />
            }
            last
          />
        </Group>

        <Group
          label="Capability probes"
          footer="Probes are tiny requests that learn what each endpoint supports. They never contain your messages."
        >
          <Stack label="Spend cap per model" last>
            <Segmented
              accessibilityLabel="Probe spend cap"
              value={String(settings.probeSpendCapUsd) as "0.01" | "0.05" | "0.25"}
              onChange={(v) => update({ probeSpendCapUsd: Number(v) })}
              options={[
                { value: "0.01", label: "$0.01" },
                { value: "0.05", label: "$0.05" },
                { value: "0.25", label: "$0.25" },
              ]}
            />
          </Stack>
        </Group>

        <Group label="About">
          <Row label="Version" value="0.1.0" />
          <Row
            label="Backend"
            value={
              (process.env.EXPO_PUBLIC_CONVEX_URL ?? "")
                .replace(/^https?:\/\//, "")
                .split(".")[0] || "Convex"
            }
          />
          <Row label="Decisions" value="Heuristic (Jev later)" last />
        </Group>
      </Page>

      <ProviderSheet
        open={providerSheet !== null}
        onClose={() => setProviderSheet(null)}
        providerId={providerSheet?.id ?? null}
      />
      <InstructionsSheet
        open={editingInstructions}
        onClose={() => setEditingInstructions(false)}
        value={settings.customInstructions}
        onSave={(customInstructions) => update({ customInstructions })}
      />
      <ModelPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={picker === "research" ? "Research model" : "Default model"}
        value={
          picker === "research"
            ? (settings.researchModelRef ?? settings.defaultModelRef)
            : settings.defaultModelRef
        }
        onSelect={(ref) =>
          update(picker === "research" ? { researchModelRef: ref } : { defaultModelRef: ref })
        }
      />
    </View>
  );
}
