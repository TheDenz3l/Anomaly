import { Switch } from "heroui-native";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, GenCard, Pill, type GenProps } from "@/genui/kit";
import { colors, fonts } from "@/lib/theme";

type FieldValue = string | number | boolean;

export function Form({ props, emit, events, busy }: GenProps<"Form">) {
  const submitted = events.at(-1)?.payload as Record<string, FieldValue> | undefined;
  const [values, setValues] = useState<Record<string, FieldValue>>(
    () =>
      submitted ??
      Object.fromEntries(
        props.fields.map((f) => [
          f.id,
          f.value ?? (f.kind === "toggle" ? false : f.kind === "number" ? 0 : ""),
        ])
      )
  );
  const [touched, setTouched] = useState(false);
  const locked = Boolean(submitted);
  const missing = props.fields.filter(
    (f) => f.required && (values[f.id] === "" || values[f.id] === undefined)
  );
  const set = (id: string, v: FieldValue) => setValues((s) => ({ ...s, [id]: v }));

  return (
    <GenCard
      title={props.title}
      icon="create-outline"
      right={locked ? <Pill label="Submitted" tone="success" icon="checkmark" /> : undefined}
    >
      <View className="gap-4">
        {props.fields.map((f) => {
          const v = values[f.id];
          const invalid = touched && missing.some((m) => m.id === f.id);
          return (
            <View key={f.id} className="gap-1.5">
              {f.kind !== "toggle" ? (
                <Text weight="medium" muted className="text-[13px]">
                  {f.label}
                  {f.required ? "" : " (optional)"}
                </Text>
              ) : null}
              {f.kind === "text" ? (
                <TextInput
                  editable={!locked}
                  value={String(v ?? "")}
                  onChangeText={(t) => set(f.id, t)}
                  placeholder={f.placeholder}
                  placeholderTextColor={colors.textFaint}
                  accessibilityLabel={f.label}
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 16,
                    color: colors.text,
                    backgroundColor: colors.raised,
                    borderRadius: 14,
                    paddingHorizontal: 14,
                    paddingVertical: 11,
                    borderWidth: 1,
                    borderColor: invalid ? colors.danger : "transparent",
                  }}
                />
              ) : f.kind === "number" ? (
                <View className="flex-row items-center gap-3">
                  <Tap
                    disabled={locked}
                    accessibilityLabel={`Decrease ${f.label}`}
                    onPress={() => set(f.id, Math.max(1, Number(v) - 1))}
                    className="h-10 w-10 items-center justify-center rounded-full bg-raised"
                  >
                    <Icon name="remove" size={18} />
                  </Tap>
                  <Text weight="bold" className="min-w-8 text-center text-lg">
                    {String(v)}
                  </Text>
                  <Tap
                    disabled={locked}
                    accessibilityLabel={`Increase ${f.label}`}
                    onPress={() => set(f.id, Number(v) + 1)}
                    className="h-10 w-10 items-center justify-center rounded-full bg-raised"
                  >
                    <Icon name="add" size={18} />
                  </Tap>
                </View>
              ) : f.kind === "select" ? (
                <View className="flex-row flex-wrap gap-2">
                  {(f.options ?? []).map((o) => {
                    const on = v === o;
                    return (
                      <Tap
                        key={o}
                        disabled={locked}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                        onPress={() => set(f.id, o)}
                        className={`rounded-full px-3.5 py-2 ${on ? "bg-primary-soft" : "bg-raised"}`}
                      >
                        <Text
                          weight={on ? "bold" : "medium"}
                          className={`text-sm ${on ? "text-primary-strong" : ""}`}
                        >
                          {o}
                        </Text>
                      </Tap>
                    );
                  })}
                </View>
              ) : (
                <View className="flex-row items-center justify-between">
                  <Text weight="medium" className="text-[15px]">
                    {f.label}
                  </Text>
                  <Switch
                    isDisabled={locked}
                    isSelected={Boolean(v)}
                    onSelectedChange={(on) => set(f.id, on)}
                  />
                </View>
              )}
            </View>
          );
        })}
        {!locked ? (
          <View className="flex-row items-center justify-between gap-3 pt-1">
            <Text muted className="flex-1 text-xs leading-4">
              {touched && missing.length
                ? `Fill in ${missing.map((m) => m.label.toLowerCase()).join(" and ")}.`
                : "Nothing is sent until you confirm."}
            </Text>
            <ActionButton
              label={props.submitLabel}
              disabled={busy}
              onPress={() => {
                setTouched(true);
                if (missing.length === 0)
                  emit("submit", `${props.submitLabel}: ${props.title}`, values);
              }}
            />
          </View>
        ) : null}
      </View>
    </GenCard>
  );
}

export function Stepper({ props, emit, events, busy }: GenProps<"Stepper">) {
  const done = events.some((e) => e.action === "complete");
  const [step, setStep] = useState(done ? props.steps.length - 1 : 0);
  const current = props.steps[step];
  const last = step === props.steps.length - 1;

  return (
    <GenCard
      title={props.title}
      subtitle={`Step ${step + 1} of ${props.steps.length}`}
      icon="list-outline"
    >
      <View className="mb-4 flex-row gap-1">
        {props.steps.map((_, i) => (
          <Tap
            key={i}
            accessibilityLabel={`Go to step ${i + 1}`}
            onPress={() => setStep(i)}
            className="flex-1 py-1"
          >
            <View
              className={`h-1 rounded-full ${i <= step || done ? "bg-primary" : "bg-raised"}`}
            />
          </Tap>
        ))}
      </View>
      <Text weight="bold" className="text-lg leading-6">
        {current.title}
      </Text>
      <Text className="mt-1.5 text-[15px] leading-6 text-ink/90">{current.detail}</Text>
      <View className="mt-4 flex-row items-center justify-between">
        <ActionButton
          label="Back"
          variant="ghost"
          size="sm"
          disabled={step === 0}
          onPress={() => setStep((s) => Math.max(0, s - 1))}
        />
        {done ? (
          <Pill label="Completed" tone="success" icon="checkmark" />
        ) : last ? (
          <ActionButton
            label="Done"
            size="sm"
            disabled={busy}
            onPress={() => emit("complete", `Finished: ${props.title}`)}
          />
        ) : (
          <ActionButton label="Next step" size="sm" onPress={() => setStep((s) => s + 1)} />
        )}
      </View>
    </GenCard>
  );
}

export function Checklist({ props }: GenProps<"Checklist">) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(props.groups.flatMap((g) => g.items.map((i) => [i.id, Boolean(i.checked)])))
  );
  const total = Object.keys(checked).length;
  const count = Object.values(checked).filter(Boolean).length;

  return (
    <GenCard title={props.title} subtitle={`${count} of ${total} packed`} icon="checkbox-outline">
      <View className="mb-3 h-1.5 overflow-hidden rounded-full bg-raised">
        <View
          className="h-full rounded-full bg-success"
          style={{ width: `${(count / total) * 100}%` }}
        />
      </View>
      <View className="gap-4">
        {props.groups.map((g) => (
          <View key={g.label}>
            <Text weight="bold" muted className="mb-1 text-[13px]">
              {g.label}
            </Text>
            {g.items.map((item) => {
              const on = checked[item.id];
              return (
                <Tap
                  key={item.id}
                  haptic
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() => setChecked((s) => ({ ...s, [item.id]: !s[item.id] }))}
                  className="flex-row items-center gap-3 py-2"
                >
                  <View
                    className={`h-[22px] w-[22px] items-center justify-center rounded-full border-2 ${on ? "border-success bg-success" : "border-[#52525B]"}`}
                  >
                    {on ? <Icon name="checkmark" size={14} color="#04120A" /> : null}
                  </View>
                  <Text
                    muted={on}
                    className={`flex-1 text-[15px] leading-5 ${on ? "line-through" : ""}`}
                  >
                    {item.label}
                  </Text>
                </Tap>
              );
            })}
          </View>
        ))}
      </View>
    </GenCard>
  );
}

export function ChoiceChips({ props, emit, events, busy }: GenProps<"ChoiceChips">) {
  const sent = events.at(-1)?.payload?.ids as string[] | undefined;
  const [picked, setPicked] = useState<string[]>(sent ?? []);
  const locked = Boolean(sent);

  const send = (ids: string[]) => {
    const labels = props.choices.filter((c) => ids.includes(c.id)).map((c) => c.label);
    emit("choose", labels.join(", "), { ids, labels });
  };

  return (
    <View className="gap-2.5">
      {props.prompt ? (
        <Text weight="medium" muted className="text-sm">
          {props.prompt}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {props.choices.map((c) => {
          const on = picked.includes(c.id);
          return (
            <Tap
              key={c.id}
              haptic
              disabled={locked || busy}
              accessibilityRole={props.multi ? "checkbox" : "button"}
              accessibilityState={{
                checked: props.multi ? on : undefined,
                selected: on,
                disabled: locked,
              }}
              onPress={() => {
                if (props.multi)
                  setPicked((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]));
                else {
                  setPicked([c.id]);
                  send([c.id]);
                }
              }}
              className={`flex-row items-center gap-1.5 rounded-full border px-3.5 py-2 ${
                on
                  ? "border-primary bg-primary-soft"
                  : locked
                    ? "border-hairline bg-transparent"
                    : "border-raised bg-card"
              }`}
              style={{ opacity: locked && !on ? 0.45 : 1 }}
            >
              {props.multi && on ? (
                <Icon name="checkmark" size={14} color={colors.primaryStrong} />
              ) : null}
              <Text
                weight={on ? "bold" : "medium"}
                className={`text-sm ${on ? "text-primary-strong" : ""}`}
              >
                {c.label}
              </Text>
            </Tap>
          );
        })}
      </View>
      {props.multi && !locked ? (
        <View className="flex-row">
          <ActionButton
            size="sm"
            label={props.submitLabel ?? "Continue"}
            disabled={busy || picked.length === 0}
            onPress={() => send(picked)}
          />
        </View>
      ) : null}
    </View>
  );
}
