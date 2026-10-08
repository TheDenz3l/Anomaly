import { useMemo, useState } from "react";
import { PanResponder, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { Slider } from "@/components/ui/Slider";
import { Text } from "@/components/ui/Text";
import { ActionButton, formatMoney, GenCard, Pill, type GenProps } from "@/genui/kit";
import type { CatalogProps } from "@/genui/schemas";
import { colors, fonts } from "@/lib/theme";

const H = 180;
const PAD = { top: 16, right: 52, bottom: 24, left: 4 };

type Series = { name: string; points: { x: number; y: number }[] };

const NO_SERIES: Series = { name: "", points: [] };

function compound(model: NonNullable<CatalogProps<"Chart">["model"]>, monthly: number): Series[] {
  const rm = model.annualRate / 12;
  const balance: Series = { name: "Balance", points: [] };
  const contributed: Series = { name: "You put in", points: [] };
  for (let year = 0; year <= model.years; year++) {
    const n = year * 12;
    const growth = Math.pow(1 + rm, n);
    const fv = model.principal * growth + (rm === 0 ? monthly * n : monthly * ((growth - 1) / rm));
    balance.points.push({ x: year, y: fv });
    contributed.points.push({ x: year, y: model.principal + monthly * n });
  }
  return [balance, contributed];
}

function compact(n: number, unit: CatalogProps<"Chart">["unit"]) {
  if (unit === "percent") return `${Math.round(n)}%`;
  const prefix = unit === "currency" ? "$" : "";
  if (n >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${prefix}${Math.round(n / 1000)}k`;
  return `${prefix}${Math.round(n)}`;
}

/** Draggable chart: the slider recomputes the series; drag across the plot to scrub values. */
export function Chart({ props, emit, events, busy }: GenProps<"Chart">) {
  const model = props.model;
  const savedValue = events.at(-1)?.payload?.monthly as number | undefined;
  const [monthly, setMonthly] = useState(savedValue ?? model?.contribution.value ?? 0);
  const [w, setW] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);

  const series = useMemo(
    () => (model ? compound(model, monthly) : (props.series ?? [])),
    [model, monthly, props.series]
  );
  const main = series[0] ?? NO_SERIES;
  const xs = main.points.map((p) => p.x);
  const maxY = Math.max(...series.flatMap((s) => s.points.map((p) => p.y))) * 1.08;
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const px = (x: number) => PAD.left + ((x - minX) / (maxX - minX || 1)) * plotW;
  const py = (y: number) => PAD.top + plotH - (y / (maxY || 1)) * plotH;

  const path = (s: Series) =>
    s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)}`)
      .join(" ");
  const area = `${path(main)} L${px(maxX)} ${py(0)} L${px(minX)} ${py(0)} Z`;
  const [scrubber] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setScrub(e.nativeEvent.locationX),
      onPanResponderMove: (e) => setScrub(e.nativeEvent.locationX),
      onPanResponderRelease: () => setScrub(null),
      onPanResponderTerminate: () => setScrub(null),
    })
  );

  if (!main.points.length) {
    return (
      <GenCard title={props.title} subtitle={props.subtitle} icon="trending-up-outline">
        <Text muted className="text-sm">
          No data to chart.
        </Text>
      </GenCard>
    );
  }

  const final = main.points[main.points.length - 1].y;
  const put = series[1]?.points[series[1].points.length - 1].y ?? 0;
  const scrubX =
    scrub === null
      ? null
      : Math.round(minX + Math.min(1, Math.max(0, (scrub - PAD.left) / plotW)) * (maxX - minX));
  const scrubPoint = scrubX === null ? null : main.points.find((p) => p.x === scrubX);
  const ticks = [0, 0.5, 1].map((t) => t * maxY);
  const saved = savedValue !== undefined;

  return (
    <GenCard title={props.title} subtitle={props.subtitle} icon="trending-up-outline">
      <View className="mb-2">
        <Text weight="bold" className="text-[30px] leading-9">
          {scrubPoint ? compact(scrubPoint.y, props.unit) : formatMoney(final)}
        </Text>
        <Text muted className="text-[13px]">
          {scrubPoint
            ? `${props.xLabel} ${scrubPoint.x}`
            : model
              ? `After ${model.years} years. You put in ${formatMoney(put)}; growth adds ${formatMoney(final - put)}.`
              : main.name}
        </Text>
      </View>

      <View
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        style={{ height: H }}
        {...scrubber.panHandlers}
      >
        {w > 0 ? (
          <Svg width={w} height={H} pointerEvents="none">
            <Defs>
              <LinearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.primary} stopOpacity={0.35} />
                <Stop offset="1" stopColor={colors.primary} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {ticks.map((t) => (
              <G key={t}>
                <Line
                  x1={PAD.left}
                  x2={PAD.left + plotW}
                  y1={py(t)}
                  y2={py(t)}
                  stroke={colors.raised}
                  strokeWidth={1}
                />
                <SvgText
                  x={w - 4}
                  y={py(t) + 4}
                  fontSize={11}
                  fontFamily={fonts.medium}
                  fill={colors.textFaint}
                  textAnchor="end"
                >
                  {compact(t, props.unit)}
                </SvgText>
              </G>
            ))}
            <Path d={area} fill="url(#chartFill)" />
            {series[1] ? (
              <Path
                d={path(series[1])}
                stroke={colors.textMuted}
                strokeWidth={1.5}
                strokeDasharray="4 4"
                fill="none"
              />
            ) : null}
            <Path d={path(main)} stroke={colors.primary} strokeWidth={2.5} fill="none" />
            {[minX, Math.round((minX + maxX) / 2), maxX].map((x) => (
              <SvgText
                key={x}
                x={px(x)}
                y={H - 6}
                fontSize={11}
                fontFamily={fonts.medium}
                fill={colors.textFaint}
                textAnchor="middle"
              >
                {String(x)}
              </SvgText>
            ))}
            {scrubPoint ? (
              <G>
                <Line
                  x1={px(scrubPoint.x)}
                  x2={px(scrubPoint.x)}
                  y1={PAD.top}
                  y2={py(0)}
                  stroke={colors.textMuted}
                  strokeWidth={1}
                />
                <Circle
                  cx={px(scrubPoint.x)}
                  cy={py(scrubPoint.y)}
                  r={5}
                  fill="#fff"
                  stroke={colors.primary}
                  strokeWidth={3}
                />
              </G>
            ) : (
              <Circle cx={px(maxX)} cy={py(final)} r={4} fill={colors.primary} />
            )}
          </Svg>
        ) : null}
      </View>

      <View className="mt-1 flex-row gap-4">
        <View className="flex-row items-center gap-1.5">
          <View className="h-0.5 w-4 rounded bg-primary" />
          <Text muted className="text-xs">
            {main.name}
          </Text>
        </View>
        {series[1] ? (
          <View className="flex-row items-center gap-1.5">
            <View className="h-0.5 w-4 rounded bg-ink-muted" />
            <Text muted className="text-xs">
              {series[1].name}
            </Text>
          </View>
        ) : null}
      </View>

      {model ? (
        <View className="mt-4 gap-1">
          <View className="flex-row items-baseline justify-between">
            <Text muted className="text-[13px]">
              {model.contribution.label}
            </Text>
            <Text weight="bold" className="text-[17px]">
              {formatMoney(monthly)}
            </Text>
          </View>
          <Slider
            value={monthly}
            min={model.contribution.min}
            max={model.contribution.max}
            step={model.contribution.step}
            onChange={setMonthly}
            accessibilityLabel={model.contribution.label}
            format={(v) => `${formatMoney(v)} a month`}
          />
          <View className="mt-2 flex-row items-center justify-between">
            {saved ? (
              <Pill
                label={`Saved at ${formatMoney(savedValue)} a month`}
                tone="success"
                icon="checkmark"
              />
            ) : (
              <View />
            )}
            <ActionButton
              size="sm"
              variant={saved ? "secondary" : "primary"}
              label={saved ? "Update plan" : `Use ${formatMoney(monthly)} a month`}
              disabled={busy || (saved && savedValue === monthly)}
              onPress={() =>
                emit("save_plan", `Saved plan at ${formatMoney(monthly)} a month`, {
                  monthly,
                  contribution: formatMoney(monthly),
                  final: formatMoney(final),
                  growth: formatMoney(final - put),
                })
              }
            />
          </View>
        </View>
      ) : null}
    </GenCard>
  );
}
