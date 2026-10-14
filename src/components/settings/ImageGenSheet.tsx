import { useRef, useState, type Ref } from "react";
import { ActivityIndicator, TextInput, View, type TextInputProps } from "react-native";
import { FormSheet, GROUP_BG } from "@/components/ui/FormSheet";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { formatCredit, formatDuration, imageBalanceFraction, timeAgo } from "@/lib/balance";
import { useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import type { ImageGenSetup, ImageProbe } from "@/lib/types";

/**
 * What's left on the saved key and what this month's images cost: the figure the service reports
 * (money or its own credits), with a bar against the key's limit or, without one, against the
 * most it held since the last top-up.
 */
function BalanceCard({ setup }: { setup: ImageGenSetup }) {
  const refresh = useApp((s) => s.refreshImageBalance);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const b = setup.balance;
  const fraction = imageBalanceFraction(setup);
  const month = new Date(now).toISOString().slice(0, 7);
  const usage = setup.usage?.month === month ? setup.usage : null;
  const figure = b && b.status !== "unsupported" ? (b.remaining ?? b.used ?? null) : null;
  const meter =
    fraction === null || fraction >= 0.2
      ? colors.success
      : fraction >= 0.05
        ? colors.warning
        : colors.danger;
  const timing = setup.timing?.model === setup.model ? setup.timing : null;

  return (
    <View className="mb-5">
      <View className="mb-2 flex-row items-center justify-between px-1">
        <Text weight="medium" muted className="text-[13px]">
          Balance
        </Text>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Refresh balance"
          disabled={busy}
          hitSlop={8}
          onPress={async () => {
            setBusy(true);
            await refresh();
            setBusy(false);
          }}
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
      <View className="overflow-hidden rounded-2xl" style={{ backgroundColor: GROUP_BG }}>
        {b && figure !== null ? (
          <View className="p-4" accessibilityLiveRegion="polite">
            <Text
              weight="bold"
              className="text-[34px] leading-[40px]"
              style={{ fontVariant: ["tabular-nums"] }}
              numberOfLines={1}
            >
              {formatCredit(figure, b.unit, b.money)}
            </Text>
            <Text muted className="text-[13px] leading-[18px]">
              {b.remaining === undefined
                ? "Used on this key"
                : b.total !== undefined
                  ? `Left of ${formatCredit(b.total, b.unit, b.money)}`
                  : b.peak !== undefined && b.peak > b.remaining
                    ? `Left of ${formatCredit(b.peak, b.unit, b.money)} since your last top-up`
                    : "Left on this key"}
            </Text>
            {fraction !== null ? (
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
                className="mt-3.5 h-1.5 overflow-hidden rounded-full"
                style={{ backgroundColor: colors.raisedHigh }}
              >
                <View
                  className="h-full rounded-full"
                  style={{ width: `${fraction * 100}%`, backgroundColor: meter }}
                />
              </View>
            ) : null}
          </View>
        ) : (
          <View className="flex-row items-center gap-2.5 p-4">
            {b ? null : <ActivityIndicator size="small" color={colors.textMuted} />}
            <Text muted className="flex-1 text-[14px] leading-5">
              {!b
                ? "Reading the balance…"
                : b.status === "unsupported"
                  ? "This service doesn’t report a balance to API keys. Check it on its site."
                  : (b.error ?? "Couldn’t read the balance.")}
            </Text>
          </View>
        )}
        <View className="flex-row items-center gap-3 border-t border-hairline px-4 py-3">
          <View className="flex-1">
            <Text weight="medium" className="text-[15px] leading-5">
              This month
            </Text>
            <Text muted className="text-[13px] leading-[18px]">
              {usage
                ? `${usage.images} ${usage.images === 1 ? "image" : "images"}`
                : "No images yet"}
            </Text>
          </View>
          {usage && usage.spent > 0 && b ? (
            <Text weight="medium" className="text-[15px]" style={{ fontVariant: ["tabular-nums"] }}>
              {formatCredit(usage.spent, b.unit, b.money)}
            </Text>
          ) : null}
        </View>
      </View>
      <Text muted className="px-1 pt-2 text-[13px] leading-[18px]">
        {b
          ? `Updated ${timeAgo(b.checkedAt, Math.max(now, b.checkedAt))}. Reads again after each image.`
          : ""}
        {timing
          ? ` Images take about ${formatDuration(timing.avgMs)} with this model, most of it at the image service.`
          : ""}
      </Text>
    </View>
  );
}

function Field({
  label,
  last,
  ...input
}: { label: string; last?: boolean; ref?: Ref<TextInput> } & Omit<TextInputProps, "style">) {
  return (
    <View className={`gap-1 px-4 py-3 ${last ? "" : "border-b border-hairline"}`}>
      <Text muted className="text-[13px]">
        {label}
      </Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ fontFamily: fonts.body, fontSize: 16, color: colors.text, paddingVertical: 4 }}
      />
    </View>
  );
}

const isUrl = (s: string) => /^https?:\/\/\S+\.\S+/i.test(s.trim());

/**
 * The user's own image model: the endpoint and key of their image service, then a model picked
 * from the ones that key can use (Find models probes the endpoint). The key goes to the server
 * encrypted and never comes back; a blank key field keeps the stored one.
 */
export function ImageGenSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = useApp((s) => s.settings.imageGen ?? null);
  const save = useApp((s) => s.saveImageGen);
  const probeEndpoint = useApp((s) => s.probeImageGen);
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [probe, setProbe] = useState<ImageProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const first = useRef<TextInput>(null);
  const run = useRef(0);

  const find = async (endpoint: string, withKey: string) => {
    const id = ++run.current;
    setProbing(true);
    setError(null);
    const res = await probeEndpoint(endpoint.trim(), withKey.trim() || undefined);
    if (id !== run.current) return;
    setProbing(false);
    if (res.ok) {
      setProbe(res.probe);
      setBaseUrl(res.probe.baseUrl);
      // Keep the pick when it's still on offer; otherwise the service's first model.
      setModel((m) =>
        res.probe.models.some((x) => x.id === m) ? m : (res.probe.models[0]?.id ?? m)
      );
    } else {
      setProbe(null);
      setError(res.error);
    }
  };

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setBaseUrl(current?.baseUrl ?? "");
      setKey("");
      setProbe(null);
      setError(null);
      setModel(current?.model ?? "");
    }
  }

  const close = () => {
    // A check still on its way is dropped.
    run.current++;
    onClose();
  };

  const canProbe =
    isUrl(baseUrl) && (key.trim().length > 0 || Boolean(current?.hasKey)) && !probing;
  const listed = probe?.models ?? [];
  // No list to pick from (the service doesn't publish one, or none of its models draw): type it.
  const typed =
    (probe !== null && listed.length === 0) || (error !== null && /model list/.test(error));
  const ready = isUrl(baseUrl) && model.trim().length > 0 && (key.trim() || current?.hasKey);
  const changed =
    !current ||
    baseUrl.trim() !== current.baseUrl ||
    model.trim() !== current.model ||
    key.trim().length > 0 ||
    (probe !== null && probe.flavor !== current.flavor);

  const submit = async () => {
    setBusy(true);
    const ok = await save({
      baseUrl: (probe?.baseUrl ?? baseUrl).trim(),
      model: model.trim(),
      key: key.trim() ? key.trim() : current ? undefined : "",
      flavor: probe?.flavor,
    });
    setBusy(false);
    if (ok) close();
  };

  const remove = async () => {
    setBusy(true);
    const ok = await save(null);
    setBusy(false);
    if (ok) close();
  };

  return (
    <FormSheet
      open={open}
      onClose={close}
      title="Image generation"
      leading={{ label: "Cancel", icon: "close", onPress: close }}
      confirm={{
        label: "Save",
        icon: "checkmark",
        disabled: busy || probing || !ready || !changed,
        onPress: () => void submit(),
      }}
      onShown={() => {
        // An existing setup is checked again as the sheet opens, with its stored key.
        if (current?.hasKey) void find(current.baseUrl, "");
        else if (!current) first.current?.focus();
      }}
    >
      {current ? <BalanceCard setup={current} /> : null}
      <Text muted className="px-1 pb-3 text-[13px] leading-[18px]">
        Add your image service’s endpoint and API key, then pick one of the models your key can use.
        Ask for a picture in any chat and Anomaly draws it with that model.
      </Text>
      <View className="overflow-hidden rounded-2xl" style={{ backgroundColor: GROUP_BG }}>
        <Field
          ref={first}
          label="Endpoint"
          value={baseUrl}
          onChangeText={(t) => {
            setBaseUrl(t);
            setProbe(null);
          }}
          placeholder="https://nanobanana.expert/api/v1"
          keyboardType="url"
          textContentType="URL"
          returnKeyType="next"
        />
        <Field
          label="API key"
          value={key}
          onChangeText={setKey}
          placeholder={
            current?.hasKey ? `${current.keyHint}, leave blank to keep it` : "Paste your key"
          }
          secureTextEntry
          textContentType="oneTimeCode"
          returnKeyType="go"
          onSubmitEditing={() => {
            if (canProbe) void find(baseUrl, key);
          }}
          last
        />
      </View>

      <Tap
        accessibilityRole="button"
        accessibilityLabel="Find models"
        accessibilityState={{ disabled: !canProbe, busy: probing }}
        onPress={() => void find(baseUrl, key)}
        disabled={!canProbe}
        className="mt-3 h-12 flex-row items-center justify-center gap-2 rounded-2xl"
        style={{ backgroundColor: GROUP_BG, opacity: canProbe || probing ? 1 : 0.5 }}
      >
        {probing ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        <Text weight="medium" className="text-base text-primary">
          {probing ? "Checking your key" : probe ? "Check again" : "Find models"}
        </Text>
      </Tap>

      {error ? (
        <Text className="px-1 pt-3 text-[13px] leading-[18px]" style={{ color: colors.danger }}>
          {error}
        </Text>
      ) : null}

      {probe ? (
        <Text muted className="px-1 pb-2 pt-5 text-[13px]">
          {listed.length === 0
            ? "The key works, but none of its models make images."
            : `${listed.length} image ${listed.length === 1 ? "model" : "models"} on this key${probe.balance?.remaining !== undefined ? `, ${formatCredit(probe.balance.remaining, probe.balance.unit, probe.balance.money)} left` : ""}`}
        </Text>
      ) : null}

      {listed.length ? (
        <View className="overflow-hidden rounded-2xl" style={{ backgroundColor: GROUP_BG }}>
          {listed.map((m, i) => {
            const picked = m.id === model;
            return (
              <Tap
                key={m.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                accessibilityLabel={m.name}
                onPress={() => setModel(m.id)}
                className={`flex-row items-center gap-3 px-4 py-3 ${i === listed.length - 1 ? "" : "border-b border-hairline"}`}
              >
                <View className="flex-1">
                  <Text weight="medium" className="text-base">
                    {m.name}
                  </Text>
                  {m.note || m.name !== m.id || current?.timing?.model === m.id ? (
                    <Text muted className="text-[13px] leading-[18px]" numberOfLines={1}>
                      {[
                        m.note ?? (m.name !== m.id ? m.id : null),
                        current?.timing?.model === m.id
                          ? `about ${formatDuration(current.timing.avgMs)} per image`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </Text>
                  ) : null}
                </View>
                {picked ? <Icon name="checkmark" size={18} color={colors.primary} /> : null}
              </Tap>
            );
          })}
        </View>
      ) : null}

      {typed ? (
        <View className="mt-3 overflow-hidden rounded-2xl" style={{ backgroundColor: GROUP_BG }}>
          <Field
            label="Model ID"
            value={model}
            onChangeText={setModel}
            placeholder="From your service’s docs"
            returnKeyType="done"
            last
          />
        </View>
      ) : null}

      <Text muted className="px-1 pt-3 text-[13px] leading-[18px]">
        The key is encrypted on the server and only used to make your images. Each image is billed
        to it.
      </Text>
      {current ? (
        <Tap
          accessibilityRole="button"
          onPress={() => void remove()}
          disabled={busy}
          className="mt-6 items-center rounded-2xl py-3.5"
          style={{ backgroundColor: GROUP_BG }}
        >
          <Text weight="medium" className="text-base" style={{ color: colors.danger }}>
            Remove image model
          </Text>
        </Tap>
      ) : null}
    </FormSheet>
  );
}
