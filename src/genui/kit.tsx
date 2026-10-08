import { Image } from "expo-image";
import { Button, Skeleton } from "heroui-native";
import { useState, type ReactNode } from "react";
import { View, type DimensionValue } from "react-native";
import { ActivityRow } from "@/components/chat/Activity";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Display, Text } from "@/components/ui/Text";
import type { CatalogName, CatalogProps } from "@/genui/schemas";
import { colors } from "@/lib/theme";
import type { UiEventPart } from "@/lib/types";

/** Props every catalog component receives from the renderer. */
export type GenProps<N extends CatalogName> = {
  props: CatalogProps<N>;
  /** Sends a structured ui_event back to the model. */
  emit: (action: string, label: string, payload?: Record<string, unknown>) => void;
  /** Events already sent for this component — lets a replayed thread show what was chosen. */
  events: UiEventPart[];
  /** True while any reply in the thread is streaming. */
  busy: boolean;
  /** True only while this component's own message is still streaming (drives live animations). */
  live: boolean;
  /** True while the card's own arguments are still streaming: props hold what has arrived so far. */
  building?: boolean;
};

/** Inline component shell: `surface` card, 24px radius (PRD §2.4). */
export function GenCard({
  title,
  subtitle,
  icon,
  right,
  children,
  footer,
  flush,
}: {
  title?: string;
  subtitle?: string;
  icon?: IconName;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
}) {
  return (
    <View className="overflow-hidden rounded-3xl bg-card">
      {title ? (
        <View className="flex-row items-center gap-3 px-4 pt-4 pb-3">
          {icon ? (
            <View className="h-8 w-8 items-center justify-center rounded-full bg-raised">
              <Icon name={icon} size={16} color={colors.textMuted} />
            </View>
          ) : null}
          <View className="flex-1">
            <Display className="text-[15px] leading-5" numberOfLines={2}>
              {title}
            </Display>
            {subtitle ? (
              <Text muted className="mt-0.5 text-[13px] leading-[18px]" numberOfLines={2}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {right}
        </View>
      ) : null}
      <View className={flush ? "" : "px-4 pb-4"}>{children}</View>
      {footer ? <View className="border-t border-hairline px-4 py-3">{footer}</View> : null}
    </View>
  );
}

/** A photo inside a card. One that fails to load leaves no broken frame behind; the card reads without it. */
export function GenImage({
  uri,
  alt,
  width = "100%",
  height,
  aspectRatio,
  radius = 16,
}: {
  uri: string;
  alt?: string;
  width?: DimensionValue;
  height?: number;
  aspectRatio?: number;
  radius?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === uri) return null;
  return (
    <Image
      source={{ uri }}
      onError={() => setFailed(uri)}
      contentFit="cover"
      transition={180}
      cachePolicy="memory-disk"
      accessible={Boolean(alt)}
      accessibilityLabel={alt}
      accessibilityIgnoresInvertColors
      style={{ width, height, aspectRatio, borderRadius: radius, backgroundColor: colors.raised }}
    />
  );
}

export function ActionButton({
  label,
  onPress,
  variant = "primary",
  disabled,
  icon,
  size = "md",
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger-soft";
  disabled?: boolean;
  icon?: IconName;
  size?: "sm" | "md";
}) {
  const fg =
    variant === "primary" ? "#FFFFFF" : variant === "danger-soft" ? colors.danger : colors.text;
  return (
    // Disabled is enforced in onPress rather than `isDisabled`: on web, flipping isDisabled while the
    // pointer rests over a freshly rendered button fires a phantom press.
    <Button
      variant={variant}
      size={size}
      onPress={() => {
        if (!disabled) onPress();
      }}
      accessibilityState={{ disabled: Boolean(disabled) }}
      className="rounded-full"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Button.Label className="font-body-bold" style={{ color: fg }}>
        {label}
      </Button.Label>
    </Button>
  );
}

/** Small rounded label: formats, statuses, scope. */
export function Pill({
  label,
  tone = "neutral",
  icon,
}: {
  label: string;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
  icon?: IconName;
}) {
  const bg = {
    neutral: "bg-raised",
    primary: "bg-primary-soft",
    success: "bg-[rgba(23,201,100,0.14)]",
    warning: "bg-[rgba(245,165,36,0.14)]",
    danger: "bg-[rgba(220,74,68,0.14)]",
  }[tone];
  const fg = {
    neutral: colors.textMuted,
    primary: colors.primaryStrong,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
  }[tone];
  return (
    <View
      style={{ maxWidth: "100%" }}
      className={`flex-row items-center gap-1 self-start rounded-full px-2 py-0.5 ${bg}`}
    >
      {icon ? <Icon name={icon} size={11} color={fg} /> : null}
      <Text
        weight="medium"
        numberOfLines={1}
        className="shrink text-[11px] leading-4"
        style={{ color: fg }}
      >
        {label}
      </Text>
    </View>
  );
}

/** What the activity line says while each component's arguments stream in. */
const building: Record<string, string> = {
  MovieShowtimes: "showtimes",
  MapCard: "the map",
  Chart: "your chart",
  Table: "a table",
  Compare: "the comparison",
  Timeline: "a timeline",
  Form: "a form",
  Stepper: "the steps",
  Checklist: "your checklist",
  ChoiceChips: "options",
  Weather: "the forecast",
  ProductGrid: "product picks",
  Blocks: "your answer",
  SubagentPlan: "a plan",
  SubagentTimeline: "the workers",
  ResearchPlan: "a research plan",
  ResearchProgress: "the research run",
  LocationRequest: "a location request",
  MemoryConfirm: "a memory",
};

/** Skeleton shown while a tool call's arguments are still streaming. Shape hints at what's coming. */
export function GenSkeleton({ name }: { name: string }) {
  const shape: Record<string, "media" | "map" | "chart" | "rows" | "grid" | "compact"> = {
    MovieShowtimes: "media",
    MapCard: "map",
    Chart: "chart",
    Weather: "chart",
    ProductGrid: "grid",
    ChoiceChips: "compact",
    LocationRequest: "compact",
    MemoryConfirm: "compact",
  };
  const kind = shape[name] ?? "rows";
  return (
    <View
      accessibilityLabel={`Building ${name}`}
      className="overflow-hidden rounded-3xl bg-card p-4"
    >
      <View className="mb-4">
        <ActivityRow orb="working" live label={`Building ${building[name] ?? "a card"}`} />
      </View>
      {kind === "media" ? (
        <View className="flex-row gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-28 rounded-2xl" />
          ))}
        </View>
      ) : kind === "map" ? (
        <Skeleton className="h-44 w-full rounded-2xl" />
      ) : kind === "chart" ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : kind === "grid" ? (
        <View className="flex-row flex-wrap gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" style={{ width: "47%" }} />
          ))}
        </View>
      ) : kind === "compact" ? (
        <View className="flex-row gap-2">
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-24 rounded-full" />
        </View>
      ) : (
        <View className="gap-3">
          <Skeleton className="h-4 w-full rounded-md" />
          <Skeleton className="h-4 w-11/12 rounded-md" />
          <Skeleton className="h-4 w-4/5 rounded-md" />
        </View>
      )}
    </View>
  );
}

export function formatMoney(n: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    // Not an ISO code ("$", "dollars"): Intl throws, so show the amount with what was given.
    return `${Math.round(n).toLocaleString("en-US")} ${currency}`.trim();
  }
}
