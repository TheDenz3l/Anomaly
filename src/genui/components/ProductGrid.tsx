import { useState } from "react";
import { View } from "react-native";
import { GeneratedArt } from "@/components/ui/GeneratedArt";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { formatMoney, GenCard, Pill, type GenProps } from "@/genui/kit";
import { colors } from "@/lib/theme";

export function ProductGrid({ props, emit, busy }: GenProps<"ProductGrid">) {
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
          return (
            <Tap
              key={p.id}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${p.brand} ${p.name}, ${formatMoney(p.price, p.currency)}, rated ${p.rating}`}
              onPress={() =>
                emit("open", `Opened ${p.brand} ${p.name}`, {
                  name: `${p.brand} ${p.name}`,
                  price: formatMoney(p.price, p.currency),
                  store: p.store,
                })
              }
              style={{ width: "48%" }}
            >
              <View>
                <GeneratedArt
                  seed={p.id + p.name}
                  width="100%"
                  height={118}
                  icon="headset"
                  radius={18}
                />
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
                  <View className="absolute bottom-2 left-2">
                    <Pill label={p.badge} tone="primary" />
                  </View>
                ) : null}
              </View>
              <Text muted className="mt-2 text-xs">
                {p.brand}
              </Text>
              <Text weight="bold" className="text-[15px] leading-5" numberOfLines={1}>
                {p.name}
              </Text>
              <View className="mt-0.5 flex-row items-center gap-1">
                <Icon name="star" size={11} color={colors.warning} />
                <Text weight="medium" className="text-xs">
                  {p.rating.toFixed(1)}
                </Text>
                <Text muted className="text-xs">
                  ({p.reviews.toLocaleString("en-US")})
                </Text>
              </View>
              <View className="mt-1 flex-row items-baseline justify-between">
                <Text weight="bold" className="text-[17px]">
                  {formatMoney(p.price, p.currency)}
                </Text>
                <Text muted className="text-xs" numberOfLines={1}>
                  {p.store}
                </Text>
              </View>
            </Tap>
          );
        })}
      </View>
    </GenCard>
  );
}
