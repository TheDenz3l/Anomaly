import * as Clipboard from "expo-clipboard";
import { Skeleton, Switch } from "heroui-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { Markdown } from "@/components/chat/Markdown";
import { ImageGallery } from "@/components/chat/Media";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Slider } from "@/components/ui/Slider";
import { Tap } from "@/components/ui/Tap";
import { Display, Text } from "@/components/ui/Text";
import { GenImage, type GenProps } from "@/genui/kit";
import type { Block } from "@/genui/schemas";
import { openLink } from "@/lib/links";
import { fadeIn } from "@/lib/motion";
import { colors, fonts } from "@/lib/theme";
import { planRows, runPlan } from "@/genui/compute";

type Of<T extends Block["type"]> = Extract<Block, { type: T }>;
type Values = Record<string, number>;
type Row = Of<"computed">["rows"][number];

/**
 * An answer built from blocks, rendered in the order the model writes them. While the call streams
 * each block fades in as it completes and text blocks are written live. Inputs and computed rows
 * recalculate on the phone, so a scaler or splitter works without another model call.
 */
export function Blocks({ props, building = false }: GenProps<"Blocks">) {
  const { blocks } = props;
  const [values, setValues] = useState<Values>({});
  const setValue = (id: string, v: number) => setValues((s) => ({ ...s, [id]: v }));

  const plan = useMemo(() => planRows(blocks), [blocks]);
  const computed = useMemo(() => {
    const scope: Values = {};
    for (const b of blocks) if (b.type === "input") scope[b.id] = values[b.id] ?? b.value;
    const out = "error" in plan ? new Map<string, number>() : runPlan(plan, scope);
    return { scope, out };
  }, [blocks, plan, values]);

  // Consecutive inputs share one panel, like the controls of a single tool.
  const groups: { at: number; items: number[] }[] = [];
  blocks.forEach((b, i) => {
    const prev = groups[groups.length - 1];
    if (b.type === "input" && prev && blocks[prev.at].type === "input") prev.items.push(i);
    else groups.push({ at: i, items: [i] });
  });

  const last = blocks[blocks.length - 1];
  const writingText = building && (last?.type === "text" || last?.type === "heading");

  return (
    <View className="gap-4">
      {groups.map(({ at, items }) => {
        const b = blocks[at];
        const writing = building && items.includes(blocks.length - 1);
        let body: ReactNode;
        if (b.type === "input") {
          body = (
            <Panel>
              {items.map((i, k) => (
                <View key={i} className={k > 0 ? "border-t border-hairline" : ""}>
                  <InputRow
                    block={blocks[i] as Of<"input">}
                    value={computed.scope[(blocks[i] as Of<"input">).id]}
                    onChange={setValue}
                  />
                </View>
              ))}
            </Panel>
          );
        } else if (b.type === "computed") {
          body = (
            <Computed
              block={b}
              values={b.rows.map((_, ri) => computed.out.get(`${at}:${ri}`) ?? NaN)}
            />
          );
        } else {
          body = <Static block={b} first={at === 0} writing={writing} />;
        }
        return (
          <Animated.View key={at} entering={building ? fadeIn : undefined}>
            {body}
          </Animated.View>
        );
      })}
      {building && !writingText ? <Skeleton className="h-4 w-2/3 rounded-md" /> : null}
    </View>
  );
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <View className={`overflow-hidden rounded-3xl bg-card px-4 ${className}`}>{children}</View>
  );
}

function Static({
  block: b,
  first,
  writing,
}: {
  block: Exclude<Block, Of<"input"> | Of<"computed">>;
  first: boolean;
  writing: boolean;
}) {
  switch (b.type) {
    case "heading":
      return (
        <View className={first ? "" : "mt-1"}>
          {b.image ? (
            <View className="mb-3">
              <GenImage uri={b.image} alt={b.text} aspectRatio={16 / 9} radius={22} />
            </View>
          ) : null}
          {first ? (
            <Display className="text-[20px] leading-7">{b.text}</Display>
          ) : (
            <Text weight="bold" className="text-[19px] leading-6">
              {b.text}
            </Text>
          )}
          {b.subtitle ? (
            <Text muted className="mt-1 text-[15px] leading-[22px]">
              {b.subtitle}
            </Text>
          ) : null}
        </View>
      );
    case "text":
      return <Markdown text={b.text} streaming={writing} />;
    case "images":
      return <ImageGallery images={b.images} live={writing} />;
    case "stats":
      return <Stats block={b} />;
    case "facts":
      return (
        <Panel>
          {b.image ? (
            <View className="-mx-4">
              <GenImage uri={b.image} alt={b.title} aspectRatio={16 / 9} radius={0} />
            </View>
          ) : null}
          {b.title ? <PanelTitle text={b.title} /> : null}
          {b.items.map((f, k) => (
            <View
              key={k}
              className={`flex-row items-baseline gap-4 py-3 ${k > 0 || b.title ? "border-t border-hairline" : ""}`}
            >
              <Text muted className="text-[14px] leading-5" style={{ maxWidth: "45%" }}>
                {f.label}
              </Text>
              <Text weight="medium" className="flex-1 text-right text-[15px] leading-5">
                {f.value}
              </Text>
            </View>
          ))}
        </Panel>
      );
    case "items":
      return <Items block={b} />;
    case "steps":
      return <Steps block={b} />;
    case "callout":
      return <Callout block={b} writing={writing} />;
    case "divider":
      return <View className="h-px bg-raised" />;
  }
}

function PanelTitle({ text, right }: { text: string; right?: ReactNode }) {
  return (
    <View className="flex-row items-center justify-between gap-3 pt-3.5 pb-2.5">
      <Text weight="bold" className="flex-1 text-[15px] leading-5">
        {text}
      </Text>
      {right}
    </View>
  );
}

function Stats({ block: b }: { block: Of<"stats"> }) {
  const wrap = b.items.length > 2;
  return (
    <View className="flex-row flex-wrap gap-2.5">
      {b.items.map((s, k) => (
        <View
          key={k}
          className="rounded-2xl bg-card px-3.5 py-3"
          style={{ flexGrow: 1, flexBasis: wrap ? "45%" : 0 }}
        >
          <Text
            weight="bold"
            numberOfLines={1}
            adjustsFontSizeToFit
            className="text-[24px] leading-8"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {s.value}
          </Text>
          <Text muted className="text-[13px] leading-[18px]">
            {s.label}
          </Text>
          {s.note ? (
            <Text className="mt-0.5 text-[12px] leading-4 text-ink-faint">{s.note}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Items({ block: b }: { block: Of<"items"> }) {
  return (
    <Panel>
      {b.title ? <PanelTitle text={b.title} /> : null}
      {b.items.map((it, k) => {
        const row = (
          <View
            className={`flex-row items-center gap-3 py-3 ${k > 0 || b.title ? "border-t border-hairline" : ""}`}
          >
            {it.image ? <GenImage uri={it.image} width={64} height={64} radius={14} /> : null}
            <View className="flex-1 gap-0.5">
              <Text weight="bold" className="text-[15px] leading-5">
                {it.title}
              </Text>
              {it.detail ? (
                <Text muted className="text-[13.5px] leading-[19px]" numberOfLines={3}>
                  {it.detail}
                </Text>
              ) : null}
            </View>
            {it.meta ? (
              <Text weight="medium" className="text-[13px] text-ink-muted" numberOfLines={1}>
                {it.meta}
              </Text>
            ) : null}
            {it.url ? <Icon name="chevron-forward" size={16} color={colors.textFaint} /> : null}
          </View>
        );
        return it.url ? (
          <Tap
            key={k}
            accessibilityRole="link"
            accessibilityLabel={it.title}
            onPress={() => openLink(it.url!)}
          >
            {row}
          </Tap>
        ) : (
          <View key={k}>{row}</View>
        );
      })}
    </Panel>
  );
}

function Steps({ block: b }: { block: Of<"steps"> }) {
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) =>
    setDone((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const count = b.steps.filter((_, i) => done.has(i)).length;
  return (
    <Panel className="pb-1">
      {b.title || b.checkable ? (
        <PanelTitle
          text={b.title ?? "Steps"}
          right={
            b.checkable ? (
              <Text muted className="text-[13px]">
                {count} of {b.steps.length}
              </Text>
            ) : undefined
          }
        />
      ) : (
        <View className="h-3.5" />
      )}
      {b.steps.map((s, i) => {
        const checked = done.has(i);
        const end = i === b.steps.length - 1;
        const marker = b.checkable ? (
          <View
            className="h-[26px] w-[26px] items-center justify-center rounded-full"
            style={
              checked
                ? { backgroundColor: colors.primary }
                : { borderWidth: 1.5, borderColor: colors.raisedHigh }
            }
          >
            {checked ? <Icon name="checkmark" size={15} color="#FFFFFF" /> : null}
          </View>
        ) : (
          <View className="h-[26px] w-[26px] items-center justify-center rounded-full bg-raised">
            <Text weight="bold" className="text-[12px]">
              {i + 1}
            </Text>
          </View>
        );
        const row = (
          <View className="flex-row gap-3">
            <View className="items-center">
              {marker}
              {end ? null : <View className="my-1 w-px flex-1 bg-raised" />}
            </View>
            <View className={`flex-1 ${end ? "pb-3.5" : "pb-4"}`}>
              {s.when ? (
                <Text weight="medium" className="text-[12px] leading-4 text-primary-strong">
                  {s.when}
                </Text>
              ) : null}
              <Text
                weight="bold"
                className={`text-[15px] leading-[22px] ${checked ? "text-ink-muted line-through" : ""}`}
              >
                {s.title}
              </Text>
              {s.detail ? (
                <Text muted className="text-[14px] leading-5">
                  {s.detail}
                </Text>
              ) : null}
              {s.image ? (
                <View className="mt-2">
                  <GenImage uri={s.image} alt={s.title} aspectRatio={16 / 9} radius={14} />
                </View>
              ) : null}
            </View>
          </View>
        );
        return b.checkable ? (
          <Tap
            key={i}
            haptic
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            accessibilityLabel={s.title}
            onPress={() => toggle(i)}
          >
            {row}
          </Tap>
        ) : (
          <View key={i}>{row}</View>
        );
      })}
    </Panel>
  );
}

const TONES: Record<Of<"callout">["tone"], { icon: IconName; color: string; bg: string }> = {
  tip: { icon: "bulb-outline", color: colors.success, bg: "rgba(23,201,100,0.10)" },
  note: { icon: "information-circle-outline", color: colors.primaryStrong, bg: colors.primarySoft },
  warning: { icon: "warning-outline", color: colors.warning, bg: "rgba(245,165,36,0.12)" },
};

function Callout({ block: b, writing }: { block: Of<"callout">; writing: boolean }) {
  const t = TONES[b.tone];
  return (
    <View className="flex-row gap-3 rounded-2xl px-3.5 py-3" style={{ backgroundColor: t.bg }}>
      <View className="pt-[3px]">
        <Icon name={t.icon} size={18} color={t.color} />
      </View>
      <View className="flex-1">
        <Markdown text={b.text} streaming={writing} />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ inputs and results */

function decimalsOf(step: number): number {
  const s = String(step);
  return s.includes(".") ? Math.min(4, s.split(".")[1].length) : 0;
}

function shown(b: Of<"input">, v: number): string {
  const n = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimalsOf(b.step ?? 1),
  }).format(v);
  return `${b.prefix ?? ""}${n}`;
}

function InputRow({
  block: b,
  value,
  onChange,
}: {
  block: Of<"input">;
  value: number;
  onChange: (id: string, v: number) => void;
}) {
  const step = b.step ?? 1;
  const min = b.min ?? (b.kind === "slider" ? 0 : -Infinity);
  const max = b.max ?? (b.kind === "slider" ? Math.max(b.value * 2, 10) : Infinity);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const set = (v: number) => onChange(b.id, clamp(Number(v.toFixed(decimalsOf(step)))));
  const label = (
    <Text weight="medium" className="flex-1 text-[15px] leading-5">
      {b.label}
    </Text>
  );
  const unit = b.unit ? (
    <Text muted className="text-[13px]">
      {b.unit}
    </Text>
  ) : null;

  if (b.kind === "toggle") {
    return (
      <View className="flex-row items-center gap-3 py-3">
        {label}
        <Switch isSelected={value !== 0} onSelectedChange={(on) => onChange(b.id, on ? 1 : 0)} />
      </View>
    );
  }
  if (b.kind === "choice") {
    return (
      <View className="gap-2.5 py-3">
        {label}
        <View className="flex-row flex-wrap gap-2">
          {(b.options ?? []).map((o) => {
            const on = o.value === value;
            return (
              <Tap
                key={o.label}
                haptic
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => onChange(b.id, o.value)}
                className={`rounded-full px-3.5 py-2 ${on ? "bg-primary-soft" : "bg-raised"}`}
              >
                <Text
                  weight={on ? "bold" : "medium"}
                  className={`text-sm ${on ? "text-primary-strong" : ""}`}
                >
                  {o.label}
                </Text>
              </Tap>
            );
          })}
        </View>
      </View>
    );
  }
  if (b.kind === "slider") {
    return (
      <View className="py-3">
        <View className="flex-row items-baseline gap-3">
          {label}
          <Text weight="bold" className="text-[17px]" style={{ fontVariant: ["tabular-nums"] }}>
            {shown(b, value)}
          </Text>
          {unit}
        </View>
        <Slider
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={set}
          accessibilityLabel={b.label}
          format={(v) => `${shown(b, v)}${b.unit ? ` ${b.unit}` : ""}`}
        />
      </View>
    );
  }
  if (b.kind === "number")
    return <NumberRow block={b} value={value} onChange={set} label={label} />;
  return (
    <View className="flex-row items-center gap-3 py-3">
      {label}
      <Tap
        haptic
        disabled={value <= min}
        accessibilityLabel={`Decrease ${b.label}`}
        onPress={() => set(value - step)}
        className="h-9 w-9 items-center justify-center rounded-full bg-raised"
        style={{ opacity: value <= min ? 0.4 : 1 }}
      >
        <Icon name="remove" size={18} />
      </Tap>
      <View className="min-w-12 items-center">
        <Text
          weight="bold"
          className="text-[17px] leading-6"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {shown(b, value)}
        </Text>
        {unit}
      </View>
      <Tap
        haptic
        disabled={value >= max}
        accessibilityLabel={`Increase ${b.label}`}
        onPress={() => set(value + step)}
        className="h-9 w-9 items-center justify-center rounded-full bg-raised"
        style={{ opacity: value >= max ? 0.4 : 1 }}
      >
        <Icon name="add" size={18} />
      </Tap>
    </View>
  );
}

function NumberRow({
  block: b,
  value,
  onChange,
  label,
}: {
  block: Of<"input">;
  value: number;
  onChange: (v: number) => void;
  label: ReactNode;
}) {
  const [text, setText] = useState(() => String(value));
  return (
    <View className="flex-row items-center gap-3 py-2.5">
      {label}
      <View className="flex-row items-center gap-1 rounded-xl bg-raised px-3">
        {b.prefix ? <Text muted>{b.prefix}</Text> : null}
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            const n = parseFloat(t.replace(/[^0-9.-]/g, ""));
            if (Number.isFinite(n)) onChange(n);
          }}
          keyboardType="decimal-pad"
          selectTextOnFocus
          accessibilityLabel={b.label}
          style={{
            fontFamily: fonts.bold,
            fontSize: 16,
            color: colors.text,
            minWidth: 56,
            textAlign: "right",
            paddingVertical: 9,
          }}
        />
        {b.unit ? <Text muted>{b.unit}</Text> : null}
      </View>
    </View>
  );
}

function format(v: number, row: Row, currency: string): string {
  if (!Number.isFinite(v)) return "—";
  const plain = (d: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(v);
  let out: string;
  switch (row.format) {
    case "currency":
      try {
        out = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
          minimumFractionDigits: row.decimals ?? 2,
          maximumFractionDigits: row.decimals ?? 2,
        }).format(v);
      } catch {
        out = `${currency} ${plain(row.decimals ?? 2)}`;
      }
      break;
    case "percent":
      out = `${plain(row.decimals ?? 1)}%`;
      break;
    case "integer":
      out = plain(0);
      break;
    default:
      out = plain(row.decimals ?? 2);
  }
  return row.unit ? `${out} ${row.unit}` : out;
}

function Computed({ block: b, values }: { block: Of<"computed">; values: number[] }) {
  const currency = b.currency ?? "USD";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    const lines = b.rows.map((r, i) => `${r.label}: ${format(values[i], r, currency)}`);
    void Clipboard.setStringAsync([b.title, ...lines].filter(Boolean).join("\n"));
    setCopied(true);
  };
  return (
    <Panel className={b.title ? "" : "pt-1"}>
      {b.title ? (
        <PanelTitle
          text={b.title}
          right={
            <Tap
              haptic
              accessibilityLabel={copied ? "Copied" : `Copy ${b.title}`}
              onPress={copy}
              className="h-8 w-8 items-center justify-center rounded-full bg-raised"
            >
              <Icon
                name={copied ? "checkmark" : "copy-outline"}
                size={15}
                color={copied ? colors.success : colors.textMuted}
              />
            </Tap>
          }
        />
      ) : null}
      {b.rows.map((r, i) =>
        r.total ? (
          <View key={i} className="flex-row items-end gap-3 border-t border-hairline py-3.5">
            <Text weight="medium" className="flex-1 pb-1 text-[15px] leading-5">
              {r.label}
            </Text>
            <Text
              weight="bold"
              className="text-[26px] leading-8"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {format(values[i], r, currency)}
            </Text>
          </View>
        ) : (
          <View
            key={i}
            className={`flex-row items-baseline gap-3 py-2.5 ${i > 0 || b.title ? "border-t border-hairline" : ""}`}
          >
            <Text muted className="flex-1 text-[14px] leading-5">
              {r.label}
            </Text>
            <Text
              weight="medium"
              className="text-[15px] leading-5"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {format(values[i], r, currency)}
            </Text>
          </View>
        )
      )}
      {b.note ? (
        <Text className="border-t border-hairline py-3 text-[12.5px] leading-[18px] text-ink-faint">
          {b.note}
        </Text>
      ) : null}
    </Panel>
  );
}
