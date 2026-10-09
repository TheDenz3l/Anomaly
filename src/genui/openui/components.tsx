import { Image } from "expo-image";
import { Skeleton, Switch } from "heroui-native";
import { useContext, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Markdown } from "@/components/chat/Markdown";
import { ImageGallery, type ImageRef } from "@/components/chat/Media";
import { Icon } from "@/components/ui/Icon";
import { Slider as SliderTrack } from "@/components/ui/Slider";
import { Tap } from "@/components/ui/Tap";
import { Display, Text } from "@/components/ui/Text";
import {
  ACCENT_COLORS,
  AccentContext,
  Panel,
  PanelTitle,
  Static,
  tint,
} from "@/genui/components/Blocks";
import { Chart as ChartCard } from "@/genui/components/Chart";
import { Compare as CompareCard, Table as TableCard } from "@/genui/components/Data";
import { MapCard } from "@/genui/components/MapCard";
import { ProductGrid } from "@/genui/components/ProductGrid";
import { Weather as WeatherCard } from "@/genui/components/Weather";
import { ActionButton, GenImage, GenSkeleton, type GenProps } from "@/genui/kit";
import {
  validateComponent,
  type Accent,
  type CatalogName,
  type CatalogProps,
} from "@/genui/schemas";
import { openLink } from "@/lib/links";
import { fadeIn } from "@/lib/motion";
import { colors } from "@/lib/theme";
import { openuiLibrary, type OpenUIComponentName } from "./library";
import {
  useIsStreaming,
  usePhoto,
  usePhotos,
  useQueryLoading,
  useRunAction,
  useStateField,
  type OpenUIComponent,
  type OpenUILibrary,
  type OpenUIRenderProps,
} from "./runtime";

/**
 * Native renderers for the OpenUI library (./library.ts). Props arrive positional-mapped and
 * evaluated, but mid-stream any of them may still be missing or cut short, so every component
 * reads them defensively and draws what it has.
 */

type Props = Record<string, unknown>;
type R = OpenUIRenderProps<Props>;
type El = { type: "element"; typeName: string; props: Props; partial?: boolean };

/** Sub-components (Stat, Step, Card…) written so far. */
const els = (v: unknown): El[] =>
  Array.isArray(v)
    ? v.filter((x): x is El => !!x && typeof x === "object" && (x as El).type === "element")
    : [];
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const useAccent = () => useContext(AccentContext);
/** Drawn the way a Blocks answer draws the same block. */
const block = (b: Props) => <Static block={b as never} first={false} writing={false} />;

/** Matches the chat column's side margin, so rows that scroll sideways run edge to edge. */
const GUTTER = 18;

function Root({ props, renderNode }: R) {
  const accent = ACCENT_COLORS[props.accent as Accent] ?? colors.primaryStrong;
  const kids = Array.isArray(props.children) ? props.children.filter((c) => c != null) : [];
  return (
    <AccentContext.Provider value={accent}>
      <View className="gap-4">
        {kids.map((c, i) => (
          <Animated.View key={i} entering={fadeIn}>
            {renderNode(c)}
          </Animated.View>
        ))}
      </View>
    </AccentContext.Provider>
  );
}

/** Darkens the lower part of a photo so the title over it reads. */
function Scrim() {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 1 1" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0.35" stopColor="#000" stopOpacity="0" />
          <Stop offset="1" stopColor="#000" stopOpacity="0.88" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="1" height="1" fill="url(#scrim)" />
    </Svg>
  );
}

function Hero({ props }: R) {
  const accent = useAccent();
  const title = str(props.title);
  const subtitle = str(props.subtitle);
  const wanted = str(props.image);
  const url = usePhoto(wanted);
  const [failed, setFailed] = useState<string | null>(null);
  const photo = url && failed !== url ? url : null;
  // A photo on its way keeps the frame it will fill; with none, the title sits on the accent.
  const framed = Boolean(photo) || (wanted !== undefined && url === undefined);
  return (
    <View
      className="overflow-hidden rounded-3xl"
      style={{ aspectRatio: framed ? 4 / 3 : undefined, backgroundColor: tint(accent, 0.16) }}
    >
      {photo ? (
        <Image
          source={{ uri: photo }}
          onError={() => setFailed(photo)}
          contentFit="cover"
          transition={250}
          cachePolicy="memory-disk"
          accessibilityIgnoresInvertColors
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {photo ? <Scrim /> : null}
      <View className={`justify-end px-5 pb-5 ${framed ? "flex-1" : "pt-10"}`}>
        {title ? (
          <Display className="text-[26px] leading-8" style={{ color: "#FFFFFF" }}>
            {title}
          </Display>
        ) : null}
        {subtitle ? (
          <Text
            className="mt-1.5 text-[15px] leading-[21px]"
            style={{ color: photo ? "rgba(255,255,255,0.85)" : colors.textMuted }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function TextC({ props, partial }: R) {
  const md = str(props.markdown);
  const streaming = useIsStreaming();
  return md ? <Markdown text={md} streaming={Boolean(partial && streaming)} /> : null;
}

function ImageC({ props }: R) {
  const caption = str(props.caption);
  const url = usePhoto(str(props.image));
  if (url === null) return null;
  return (
    <View className="gap-2">
      {url ? (
        <GenImage uri={url} alt={caption} aspectRatio={4 / 3} radius={22} />
      ) : (
        <Skeleton className="w-full rounded-3xl" style={{ aspectRatio: 4 / 3 }} />
      )}
      {caption ? (
        <Text muted className="px-1 text-[13px] leading-[18px]">
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/** A page as it looks now, captured by the server; tapping opens the page. */
function ScreenshotC({ props }: R) {
  const page = str(props.url);
  const caption = str(props.caption);
  const shot = usePhoto(page ? `screenshot:${page.trim()}` : undefined);
  if (!page || shot === null) return null;
  return (
    <View className="gap-2">
      <Tap
        haptic
        accessibilityRole="link"
        accessibilityLabel={caption ?? page}
        onPress={() => void openLink(page)}
      >
        {shot ? (
          <GenImage uri={shot} alt={caption ?? page} aspectRatio={16 / 10} radius={18} />
        ) : (
          <Skeleton className="w-full rounded-[18px]" style={{ aspectRatio: 16 / 10 }} />
        )}
      </Tap>
      <View className="flex-row items-center gap-1.5 px-1">
        <Icon name="globe-outline" size={13} color={colors.textMuted} />
        <Text muted numberOfLines={1} className="flex-1 text-[13px] leading-[18px]">
          {caption ?? hostOf(page)}
        </Text>
      </View>
    </View>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function Gallery({ props, partial }: R) {
  const wanted = (Array.isArray(props.images) ? props.images : []).map(str);
  const urls = usePhotos(wanted);
  const images = urls.flatMap((u, i): ImageRef[] => (u ? [{ url: u, alt: wanted[i] ?? "" }] : []));
  const waiting = partial || urls.some((u) => u === undefined);
  const title = str(props.title);
  if (!images.length && !waiting) return null;
  return (
    <View className="gap-2.5">
      {title ? (
        <Text weight="bold" className="text-[15px] leading-5">
          {title}
        </Text>
      ) : null}
      {images.length ? (
        <ImageGallery images={images} live={waiting} />
      ) : (
        <View className="flex-row gap-2.5">
          <Skeleton className="h-44 w-40 rounded-2xl" />
          <Skeleton className="h-44 w-40 rounded-2xl" />
        </View>
      )}
    </View>
  );
}

function Stats({ props }: R) {
  const items = els(props.items)
    .map((e) => ({
      value: str(e.props.value),
      label: str(e.props.label),
      note: str(e.props.note),
    }))
    .filter((s) => s.value && s.label)
    .slice(0, 4);
  return items.length ? block({ type: "stats", items }) : null;
}

/** Short values sit beside their label; long ones read better on their own line. */
function Facts({ props }: R) {
  const title = str(props.title);
  const items = els(props.items)
    .map((e) => ({ label: str(e.props.label), value: str(e.props.value) }))
    .filter((f): f is { label: string; value: string } => Boolean(f.label && f.value));
  if (!items.length) return null;
  return (
    <Panel>
      {title ? <PanelTitle text={title} /> : null}
      {items.map((f, k) => {
        const border = k > 0 || title ? "border-t border-hairline" : "";
        return f.value.length <= 28 ? (
          <View key={k} className={`flex-row items-baseline gap-4 py-3 ${border}`}>
            <Text muted className="flex-1 text-[14px] leading-5">
              {f.label}
            </Text>
            <Text weight="medium" className="text-right text-[15px] leading-5">
              {f.value}
            </Text>
          </View>
        ) : (
          <View key={k} className={`gap-1 py-3 ${border}`}>
            <Text muted className="text-[13px] leading-[18px]">
              {f.label}
            </Text>
            <Text className="text-[15px] leading-[22px]">{f.value}</Text>
          </View>
        );
      })}
    </Panel>
  );
}

function Steps({ props }: R) {
  const raw = els(props.steps).map((e) => e.props);
  const urls = usePhotos(raw.map((s) => str(s.image)));
  const steps = raw
    .map((s, i) => ({
      title: str(s.title),
      detail: str(s.detail),
      when: str(s.when),
      image: urls[i] ?? undefined,
    }))
    .filter((s) => s.title);
  if (!steps.length) return null;
  return block({
    type: "steps",
    title: str(props.title),
    checkable: props.checkable === true,
    steps,
  });
}

function Bars({ props }: R) {
  const items = els(props.items)
    .map((e) => ({
      label: str(e.props.label),
      value: num(e.props.value),
      display: str(e.props.display),
      note: str(e.props.note),
    }))
    .filter((b) => b.label && b.value !== undefined);
  return items.length >= 2
    ? block({ type: "bars", title: str(props.title), unit: str(props.unit), items })
    : null;
}

function Callout({ props }: R) {
  const text = str(props.text);
  const tone = ["tip", "note", "warning"].includes(props.tone as string) ? props.tone : "note";
  return text ? block({ type: "callout", tone, text }) : null;
}

function Quote({ props }: R) {
  const text = str(props.text);
  return text ? block({ type: "quote", text, cite: str(props.cite) }) : null;
}

function Quiz({ props, partial }: R) {
  const question = str(props.question);
  const choices = (Array.isArray(props.choices) ? props.choices : []).map(str).filter(Boolean);
  const answer = num(props.answer);
  // The right answer has to be known before the user can pick.
  if (partial || !question || choices.length < 2 || answer === undefined) return null;
  if (answer < 0 || answer >= choices.length) return null;
  return block({ type: "quiz", question, choices, answer, explanation: str(props.explanation) });
}

function FlipCards({ props }: R) {
  const cards = els(props.cards)
    .map((e) => ({ front: str(e.props.front), back: str(e.props.back) }))
    .filter((c) => c.front && c.back);
  return cards.length ? block({ type: "cards", title: str(props.title), cards }) : null;
}

function CardTile({ card, width }: { card: El; width?: number }) {
  const run = useRunAction();
  const accent = useAccent();
  const p = card.props;
  const title = str(p.title);
  const wanted = str(p.image);
  const url = usePhoto(wanted);
  if (!title) return null;
  const meta = str(p.meta);
  const body = str(p.body);
  return (
    <Tap
      haptic
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => run(p.action, `Tell me more about ${title}`)}
      // In a row, every card takes the height of the tallest.
      style={width ? { width, alignSelf: "stretch" } : undefined}
    >
      <View className="flex-1 overflow-hidden rounded-3xl bg-card">
        {/* The frame holds the place while a photo is found; with none found the card goes without. */}
        {url ? (
          <GenImage uri={url} alt={title} aspectRatio={4 / 3} radius={0} />
        ) : wanted && url === undefined ? (
          <View style={{ aspectRatio: 4 / 3, backgroundColor: tint(accent, 0.14) }} />
        ) : null}
        <View className="gap-1 p-3.5">
          {meta ? (
            <Text weight="medium" className="text-[12px] leading-4" style={{ color: accent }}>
              {meta}
            </Text>
          ) : null}
          <Text weight="bold" className="text-[15px] leading-5" numberOfLines={2}>
            {title}
          </Text>
          {body ? (
            <Text muted className="text-[13px] leading-[18px]" numberOfLines={3}>
              {body}
            </Text>
          ) : null}
        </View>
      </View>
    </Tap>
  );
}

function Carousel({ props }: R) {
  const cards = els(props.cards);
  const title = str(props.title);
  if (!cards.length) return null;
  const W = 224;
  return (
    <View className="gap-2.5">
      {title ? (
        <Text weight="bold" className="text-[15px] leading-5">
          {title}
        </Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={W + 12}
        decelerationRate="fast"
        style={{ marginHorizontal: -GUTTER }}
        contentContainerStyle={{ gap: 12, paddingHorizontal: GUTTER }}
      >
        {cards.map((c, i) => (
          <CardTile key={i} card={c} width={W} />
        ))}
      </ScrollView>
    </View>
  );
}

function CardC({ props, partial }: R) {
  return <CardTile card={{ type: "element", typeName: "Card", props, partial }} />;
}

function Grid({ props, renderNode }: R) {
  const kids = Array.isArray(props.children) ? props.children.filter((c) => c != null) : [];
  return (
    <View className="flex-row flex-wrap" style={{ gap: 12 }}>
      {kids.map((c, i) => (
        <View key={i} style={{ flexBasis: "46%", flexGrow: 1 }}>
          {renderNode(c)}
        </View>
      ))}
    </View>
  );
}

/**
 * A component's own setting (the tab picked, a section opened): kept in the card's store under the
 * component's statement name, so it's saved with the card; a component written inline has no name
 * to keep it under, so it holds it itself.
 */
function useOwnState<T>(statementId: string | undefined, initial: T): [T, (v: T) => void] {
  "use no memo";
  const [local, setLocal] = useState(initial);
  const field = useStateField<T>(statementId ?? "", undefined);
  if (!statementId) return [local, setLocal];
  return [(field.value as T | undefined) ?? initial, field.setValue];
}

function Tabs({ props, renderNode, statementId }: R) {
  const accent = useAccent();
  const tabs = els(props.tabs).filter((t) => str(t.props.label));
  const [picked, setPicked] = useOwnState(statementId, 0);
  if (!tabs.length) return null;
  const at = Math.min(Math.max(0, num(picked) ?? 0), tabs.length - 1);
  return (
    <View className="gap-3">
      <View className="flex-row rounded-full bg-card p-1">
        {tabs.map((t, k) => {
          const on = k === at;
          return (
            <Tap
              key={k}
              haptic
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setPicked(k)}
              style={{ flex: 1 }}
            >
              <View
                className="items-center rounded-full px-2 py-2"
                style={on ? { backgroundColor: tint(accent, 0.22) } : undefined}
              >
                <Text
                  weight={on ? "bold" : "medium"}
                  numberOfLines={1}
                  className="text-[13px] leading-[18px]"
                  style={{ color: on ? accent : colors.textMuted }}
                >
                  {str(t.props.label)}
                </Text>
              </View>
            </Tap>
          );
        })}
      </View>
      <Animated.View key={at} entering={fadeIn} className="gap-4">
        {renderNode(tabs[at].props.children)}
      </Animated.View>
    </View>
  );
}

function Section({ props, renderNode, statementId }: R) {
  const [open, setOpen] = useOwnState(statementId, props.open === true);
  const title = str(props.title);
  if (!title) return null;
  return (
    <View className="gap-3">
      <Tap
        haptic
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <View className="flex-row items-center gap-3 rounded-3xl bg-card px-4 py-3.5">
          <Text weight="bold" className="flex-1 text-[15px] leading-5">
            {title}
          </Text>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} />
        </View>
      </Tap>
      {open ? (
        <Animated.View entering={fadeIn} className="gap-4">
          {renderNode(props.children)}
        </Animated.View>
      ) : null}
    </View>
  );
}

function Labelled({
  label,
  value,
  children,
}: {
  label?: string;
  value?: string;
  children: ReactNode;
}) {
  const accent = useAccent();
  return (
    <Panel className="gap-2.5 py-3.5">
      {label || value ? (
        <View className="flex-row items-baseline justify-between gap-3">
          <Text muted className="flex-1 text-[14px] leading-5">
            {label}
          </Text>
          {value ? (
            <Text weight="bold" className="text-[15px] leading-5" style={{ color: accent }}>
              {value}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </Panel>
  );
}

function Choice({ props, statementId }: R) {
  const accent = useAccent();
  const field = useStateField<unknown>(statementId ?? "choice", props.value);
  const options = (Array.isArray(props.options) ? props.options : [])
    .map(str)
    .filter((o): o is string => Boolean(o));
  const current = field.value == null ? undefined : String(field.value);
  return (
    <Labelled label={str(props.label)}>
      <View className="flex-row flex-wrap gap-2">
        {options.map((o) => {
          const on = o === current;
          return (
            <Tap
              key={o}
              haptic
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              // A number stays a number, so arithmetic on the $variable still adds.
              onPress={() =>
                field.setValue(typeof field.value === "number" && num(o) !== undefined ? num(o) : o)
              }
            >
              <View
                className="rounded-full px-3.5 py-2"
                style={{ backgroundColor: on ? tint(accent, 0.22) : colors.raised }}
              >
                <Text
                  weight={on ? "bold" : "medium"}
                  className="text-[14px] leading-5"
                  style={{ color: on ? accent : colors.text }}
                >
                  {o}
                </Text>
              </View>
            </Tap>
          );
        })}
      </View>
    </Labelled>
  );
}

/** A number with its unit the way people write it: "$10,000", "7%", "4 people". */
function withUnit(v: number, unit: string | undefined): string {
  const n = Number(v.toFixed(4)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (!unit) return n;
  if (unit === "%") return `${n}%`;
  if (currencyOf(unit) && !/^[A-Za-z]{3}$/.test(unit)) return `${unit}${n}`;
  return `${n} ${unit}`;
}

function SliderC({ props, statementId }: R) {
  const field = useStateField<unknown>(statementId ?? "slider", props.value);
  const min = num(props.min) ?? 0;
  const max = Math.max(min + 1, num(props.max) ?? 100);
  const step = num(props.step) ?? 1;
  const value = Math.min(max, Math.max(min, num(field.value) ?? min));
  const unit = str(props.unit);
  const shown = (v: number) => withUnit(v, unit);
  return (
    <Labelled label={str(props.label)} value={shown(value)}>
      <SliderTrack
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(v) => field.setValue(v)}
        accessibilityLabel={str(props.label) ?? "Value"}
        format={shown}
      />
    </Labelled>
  );
}

function Toggle({ props, statementId }: R) {
  const field = useStateField<unknown>(statementId ?? "toggle", props.value);
  return (
    <Panel className="py-3">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-[15px] leading-5">{str(props.label)}</Text>
        <Switch isSelected={field.value === true} onSelectedChange={(on) => field.setValue(on)} />
      </View>
    </Panel>
  );
}

/** Money built as "$" + a rounded number reads "$46.5"; shown as money it reads "$46.50". */
function moneyOrAsIs(text: string): string {
  const m = /^([$€£¥])\s?(-?\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return text;
  const n = Number(m[2]);
  return `${m[1]}${n.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function Value({ props }: R) {
  const accent = useAccent();
  const label = str(props.label);
  const v = props.value;
  const shown =
    typeof v === "number"
      ? Number.isFinite(v)
        ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v)
        : "—"
      : moneyOrAsIs(str(v) ?? "—");
  return (
    <Panel className="gap-0.5 py-4">
      {label ? (
        <Text muted className="text-[13px] leading-[18px]">
          {label}
        </Text>
      ) : null}
      <Text weight="bold" className="text-[34px] leading-[42px]" style={{ color: accent }}>
        {shown}
      </Text>
      {str(props.note) ? (
        <Text muted className="text-[13px] leading-[18px]">
          {str(props.note)}
        </Text>
      ) : null}
    </Panel>
  );
}

function ButtonView({ props }: { props: Props }) {
  const run = useRunAction();
  const streaming = useIsStreaming();
  const label = str(props.label);
  if (!label) return null;
  return (
    <ActionButton
      label={label}
      size="sm"
      variant={props.style === "primary" ? "primary" : "secondary"}
      disabled={streaming}
      onPress={() => run(props.action, label)}
    />
  );
}

function Buttons({ props }: R) {
  const buttons = els(props.buttons);
  if (!buttons.length) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {buttons.map((b, i) => (
        <ButtonView key={i} props={b.props} />
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ the app's own cards */

const noop = () => {};

/**
 * One of the app's catalog cards drawn inside an OpenUI card, once what the program gave it fits
 * the catalog's schema (repaired where it can be); null until then.
 */
function catalogCard<N extends CatalogName>(
  name: N,
  Card: (p: GenProps<N>) => ReactNode,
  props: unknown
): ReactNode {
  const v = validateComponent(name, props);
  return v.ok ? (
    <Card props={v.props as CatalogProps<N>} emit={noop} events={[]} busy={false} live={false} />
  ) : null;
}

/** A cell as a table shows it: numbers stay numbers. */
const cell = (v: unknown): string | number =>
  typeof v === "number" && Number.isFinite(v) ? v : (str(v) ?? "");

function TableC({ props }: R) {
  const columns = (Array.isArray(props.columns) ? props.columns : [])
    .map(str)
    .filter((c): c is string => Boolean(c));
  // Rows as lists of cells, or as objects keyed by column (a Query's records).
  const rows = (Array.isArray(props.rows) ? props.rows : [])
    .filter((r) => r && typeof r === "object")
    .map((r) =>
      Array.isArray(r) ? r : columns.map((c) => (r as Record<string, unknown>)[c] ?? "")
    );
  if (!columns.length || !rows.length) return null;
  const numeric = columns.map((_, c) =>
    rows.every((r) => typeof r[c] === "number" || r[c] == null || r[c] === "")
  );
  return catalogCard("Table", TableCard, {
    title: str(props.title),
    columns: columns.map((label, c) => ({ key: `c${c}`, label, numeric: numeric[c] || undefined })),
    rows: rows.map((r) => Object.fromEntries(columns.map((_, c) => [`c${c}`, cell(r[c])]))),
  });
}

function ChartC({ props }: R) {
  const series = els(props.series)
    .map((e) => ({
      name: str(e.props.name) ?? "",
      points: (Array.isArray(e.props.points) ? e.props.points : [])
        .map((pt) => (Array.isArray(pt) ? { x: num(pt[0]), y: num(pt[1]) } : null))
        .filter((pt): pt is { x: number; y: number } => pt?.x !== undefined && pt.y !== undefined),
    }))
    .filter((x) => x.points.length >= 2);
  if (!series.length) return null;
  const unit = ["number", "currency", "percent"].includes(props.unit as string)
    ? props.unit
    : "number";
  return catalogCard("Chart", ChartCard, {
    title: str(props.title) ?? "Chart",
    unit,
    xLabel: str(props.xLabel) ?? "",
    series,
  });
}

function CompareC({ props }: R) {
  const raw = els(props.items).map((e) => e.props);
  const urls = usePhotos(raw.map((i) => str(i.image)));
  const items = raw
    .map((i, k) => ({
      id: `i${k}`,
      name: str(i.name),
      subtitle: str(i.subtitle),
      image: urls[k] ?? undefined,
    }))
    .filter((i) => i.name)
    .slice(0, 3);
  const rows = els(props.rows)
    .map((e) => ({
      label: str(e.props.label),
      values: (Array.isArray(e.props.values) ? e.props.values : []).map((v) => str(v) ?? "—"),
      winner: num(e.props.winner),
    }))
    .filter((r) => r.label && r.values.length);
  if (items.length < 2 || !rows.length) return null;
  return catalogCard("Compare", CompareCard, {
    title: str(props.title),
    items,
    rows,
    verdict: str(props.verdict),
  });
}

/** A pin as written (a Place) or as a places Query returns it. */
function pinOf(v: unknown, k: number) {
  const p = (v && typeof v === "object" && (v as El).type === "element" ? (v as El).props : v) as
    Props | undefined;
  const lat = num(p?.lat);
  const lng = num(p?.lng);
  const name = str(p?.name);
  if (!p || lat === undefined || lng === undefined || !name) return null;
  return {
    id: `p${k}`,
    name,
    subtitle: str(p.note) ?? str(p.address),
    lat,
    lng,
    distanceKm: num(p.distanceKm),
  };
}

function MapC({ props }: R) {
  const loading = useQueryLoading();
  const streaming = useIsStreaming();
  const places = (Array.isArray(props.places) ? props.places : [])
    .map(pinOf)
    .filter((p): p is NonNullable<ReturnType<typeof pinOf>> => p !== null);
  if (!places.length) return loading || streaming ? <GenSkeleton name="MapCard" /> : null;
  const title = str(props.title);
  const c = props.center as Props | null | undefined;
  const center =
    num(c?.lat) !== undefined && num(c?.lng) !== undefined
      ? { lat: num(c!.lat)!, lng: num(c!.lng)!, label: str(c!.label) ?? title ?? "the map" }
      : {
          lat: places.reduce((t, p) => t + p.lat, 0) / places.length,
          lng: places.reduce((t, p) => t + p.lng, 0) / places.length,
          label: title ?? "the map",
        };
  return catalogCard("MapCard", MapCard, { title, center, places });
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  US$: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
  A$: "AUD",
  C$: "CAD",
  CA$: "CAD",
  NZ$: "NZD",
  HK$: "HKD",
  S$: "SGD",
  R$: "BRL",
  "₺": "TRY",
  "₽": "RUB",
  "₪": "ILS",
  "₫": "VND",
  "₱": "PHP",
  "฿": "THB",
};

/** A currency as written, as an ISO code: "EUR", "eur" or "€". Null when it's none of these. */
function currencyOf(v: unknown): string | null {
  const s = str(v)?.trim();
  if (!s) return null;
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return CURRENCY_SYMBOLS[s] ?? null;
}

/**
 * A product as written. Products once had no currency argument; a program written that way has
 * the store where the currency goes and everything after it one place along, so it's read back
 * into place (in US dollars).
 */
function productOf(p: Props) {
  const currency = currencyOf(p.currency);
  const [store, url, image, brand, rating] = currency
    ? [p.store, p.url, p.image, p.brand, p.rating]
    : [p.currency, p.store, p.url, p.image, p.brand];
  return {
    name: str(p.name),
    price: num(p.price),
    currency: currency ?? "USD",
    store: str(store) ?? "",
    url: str(url),
    image: str(image),
    brand: str(brand) ?? "",
    rating: num(rating),
  };
}

function ProductsC({ props }: R) {
  const raw = els(props.items).map((e) => productOf(e.props));
  const urls = usePhotos(raw.map((p) => p.image));
  const products = raw
    .map((p, k) => ({ ...p, id: `p${k}`, image: urls[k] ?? undefined }))
    .filter((p) => p.name && p.price !== undefined && p.price > 0);
  if (!products.length) return null;
  return catalogCard("ProductGrid", ProductGrid, { title: str(props.title), products });
}

function WeatherC({ props }: R) {
  const loading = useQueryLoading();
  const streaming = useIsStreaming();
  const card = props.data ? catalogCard("Weather", WeatherCard, props.data) : null;
  if (card) return card;
  return loading || streaming ? <GenSkeleton name="Weather" /> : null;
}

function Input({ props, statementId }: R) {
  const field = useStateField<unknown>(statementId ?? "input", props.value);
  const label = str(props.label);
  return (
    <Labelled label={label}>
      <TextInput
        value={field.value == null ? "" : String(field.value)}
        onChangeText={(t) => field.setValue(t)}
        placeholder={str(props.placeholder)}
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={label ?? str(props.placeholder)}
        className="rounded-2xl bg-raised px-3.5 py-3 font-body text-[15px] text-ink"
      />
    </Labelled>
  );
}

/** Sub-components drawn by their parent. */
const ByParent: OpenUIComponent = () => null;

const renderers: Record<OpenUIComponentName, OpenUIComponent> = {
  Root,
  Hero,
  Text: TextC,
  Image: ImageC,
  Screenshot: ScreenshotC,
  Gallery,
  Stats,
  Stat: ByParent,
  Facts,
  Fact: ByParent,
  Steps,
  Step: ByParent,
  Bars,
  Bar: ByParent,
  Table: TableC,
  Chart: ChartC,
  Series: ByParent,
  Compare: CompareC,
  Item: ByParent,
  Row: ByParent,
  Map: MapC,
  Place: ByParent,
  Products: ProductsC,
  Product: ByParent,
  Weather: WeatherC,
  Callout,
  Quote,
  Quiz,
  FlipCards,
  Flip: ByParent,
  Carousel,
  Card: CardC,
  Grid,
  Tabs,
  Tab: ByParent,
  Section,
  Choice,
  Slider: SliderC,
  Toggle,
  Input,
  Value,
  Buttons,
  Button: ({ props }) => <ButtonView props={props} />,
};

export const nativeLibrary: OpenUILibrary = openuiLibrary(renderers);
