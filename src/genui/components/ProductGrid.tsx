import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import { GeneratedArt } from "@/components/ui/GeneratedArt";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { formatMoney, GenCard, Pill, type GenProps } from "@/genui/kit";
import { openLink } from "@/lib/links";
import { colors } from "@/lib/theme";

type Product = GenProps<"ProductGrid">["props"]["products"][number];

/** The product photo, or generated art when there's none or it fails to load. */
function Photo({ p }: { p: Product }) {
  const [failed, setFailed] = useState(false);
  if (!p.image || failed) {
    return (
      <GeneratedArt
        seed={p.id + p.name}
        width="100%"
        height={118}
        icon="pricetag-outline"
        radius={18}
      />
    );
  }
  return (
    <Image
      source={{ uri: p.image }}
      onError={() => setFailed(true)}
      contentFit="cover"
      transition={180}
      cachePolicy="memory-disk"
      accessibilityIgnoresInvertColors
      style={{ width: "100%", height: 118, borderRadius: 18, backgroundColor: colors.raised }}
    />
  );
}

/**
 * Products to buy. Tapping one opens its page in the in-app browser; it doesn't post to the chat,
 * since a card that points at a page should take you there (choices are what continue the chat).
 */
export function ProductGrid({ props }: GenProps<"ProductGrid">) {
  const [liked, setLiked] = useState<string[]>([]);
  return (
    <GenCard
      title={props.title ?? "Products"}
      subtitle="Prices checked today"
      icon="bag-handle-outline"
    >
      <View className="flex-row flex-wrap justify-between gap-y-4">
        {props.products.map((p) => {
          const on = liked.includes(p.id);
          const rated = p.rating !== undefined && p.rating > 0;
          return (
            <Tap
              key={p.id}
              disabled={!p.url}
              accessibilityRole={p.url ? "link" : undefined}
              accessibilityLabel={`${p.brand} ${p.name}, ${formatMoney(p.price, p.currency)}${rated ? `, rated ${p.rating}` : ""}`}
              accessibilityHint={p.url ? `Opens ${p.store}` : undefined}
              onPress={() => {
                if (p.url) void openLink(p.url);
              }}
              style={{ width: "48%" }}
            >
              <View>
                <Photo p={p} />
                <Tap
                  haptic
                  accessibilityLabel={on ? "Remove from saved" : "Save"}
                  onPress={() => setLiked((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                  hitSlop={8}
                  className="absolute right-2 top-2 h-8 w-8 items-center justify-center rounded-full bg-black/50"
                >
                  <Icon
                    name={on ? "heart" : "heart-outline"}
                    size={16}
                    color={on ? colors.danger : "#fff"}
                  />
                </Tap>
                {p.badge ? (
                  <View className="absolute bottom-2 left-2 right-2">
                    <Pill label={p.badge} tone="primary" />
                  </View>
                ) : null}
              </View>
              <Text muted className="mt-2 text-xs" numberOfLines={1}>
                {p.brand}
              </Text>
              <Text weight="bold" className="text-[15px] leading-5" numberOfLines={2}>
                {p.name}
              </Text>
              {rated ? (
                <View className="mt-0.5 flex-row items-center gap-1">
                  <Icon name="star" size={11} color={colors.warning} />
                  <Text weight="medium" className="text-xs">
                    {p.rating!.toFixed(1)}
                  </Text>
                  {p.reviews ? (
                    <Text muted className="text-xs">
                      ({p.reviews.toLocaleString("en-US")})
                    </Text>
                  ) : null}
                </View>
              ) : null}
              <View className="mt-1 flex-row items-baseline justify-between gap-2">
                <Text weight="bold" className="text-[17px]">
                  {formatMoney(p.price, p.currency)}
                </Text>
                <View className="shrink flex-row items-center gap-0.5">
                  <Text muted className="shrink text-xs" numberOfLines={1}>
                    {p.store}
                  </Text>
                  {p.url ? <Icon name="open-outline" size={11} color={colors.textMuted} /> : null}
                </View>
              </View>
            </Tap>
          );
        })}
      </View>
    </GenCard>
  );
}
