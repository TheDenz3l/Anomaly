import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Segmented } from "@/components/ui/Segmented";
import { Text } from "@/components/ui/Text";
import { GenCard, type GenProps } from "@/genui/kit";
import type { CatalogProps } from "@/genui/schemas";
import { colors } from "@/lib/theme";

type Condition = CatalogProps<"Weather">["now"]["condition"];

const icons: Record<Condition, { name: IconName; color: string }> = {
  clear: { name: "sunny", color: "#FACC15" },
  partly: { name: "partly-sunny", color: "#FDE68A" },
  cloudy: { name: "cloud", color: "#A1A1AA" },
  rain: { name: "rainy", color: "#60A5FA" },
  storm: { name: "thunderstorm", color: "#A78BFA" },
  snow: { name: "snow", color: "#E0F2FE" },
  fog: { name: "cloud-outline", color: "#A1A1AA" },
  night: { name: "moon", color: "#C7D2FE" },
};

export function Weather({ props }: GenProps<"Weather">) {
  const [unit, setUnit] = useState<"C" | "F">("C");
  const t = (c: number) => Math.round(unit === "C" ? c : c * 1.8 + 32);
  const lo = Math.min(...props.daily.map((d) => d.lowC));
  const hi = Math.max(...props.daily.map((d) => d.highC));
  const now = icons[props.now.condition];

  return (
    <GenCard
      title={props.location}
      subtitle={props.updated}
      icon="location-outline"
      right={
        <View style={{ width: 92 }}>
          <Segmented
            accessibilityLabel="Temperature unit"
            value={unit}
            onChange={setUnit}
            options={[
              { value: "C", label: "°C" },
              { value: "F", label: "°F" },
            ]}
          />
        </View>
      }
    >
      <View className="flex-row items-center gap-4">
        <Text
          weight="bold"
          className="text-[56px] leading-[60px]"
          accessibilityLabel={`${t(props.now.tempC)} degrees`}
        >
          {t(props.now.tempC)}°
        </Text>
        <View className="flex-1">
          <Icon name={now.name} size={30} color={now.color} />
          <Text weight="medium" className="mt-1 text-[15px] leading-5">
            {props.now.summary}
          </Text>
          <Text muted className="text-[13px]">
            High {t(props.now.highC)}°, low {t(props.now.lowC)}°
          </Text>
        </View>
      </View>

      <View className="mt-4 flex-row justify-between rounded-2xl bg-raised px-3 py-2.5">
        {[
          { label: "Feels like", value: `${t(props.now.feelsLikeC)}°` },
          { label: "Wind", value: `${props.now.windKmh} km/h` },
          { label: "Humidity", value: `${props.now.humidity}%` },
          { label: "Rain", value: `${props.now.precipChance}%` },
        ].map((s) => (
          <View key={s.label} className="items-center">
            <Text muted className="text-[11px]">
              {s.label}
            </Text>
            <Text weight="bold" className="text-sm">
              {s.value}
            </Text>
          </View>
        ))}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-4 mt-4"
        contentContainerStyle={{ paddingHorizontal: 16, gap: 18 }}
      >
        {props.hourly.map((h) => {
          const ic = icons[h.condition];
          return (
            <View key={h.time} className="items-center gap-1.5">
              <Text muted weight="medium" className="text-xs">
                {h.time}
              </Text>
              <Icon name={ic.name} size={20} color={ic.color} />
              <Text weight="bold" className="text-[15px]">
                {t(h.tempC)}°
              </Text>
              <Text
                weight="bold"
                className="text-[11px]"
                style={{ color: h.precipChance >= 30 ? colors.primaryStrong : "transparent" }}
              >
                {h.precipChance}%
              </Text>
            </View>
          );
        })}
      </ScrollView>

      <View className="mt-3 border-t border-hairline pt-2">
        {props.daily.map((d) => {
          const ic = icons[d.condition];
          const left = ((d.lowC - lo) / (hi - lo || 1)) * 100;
          const width = ((d.highC - d.lowC) / (hi - lo || 1)) * 100;
          return (
            <View key={d.day} className="flex-row items-center gap-3 py-1.5">
              <Text weight="medium" className="w-10 text-[15px]">
                {d.day}
              </Text>
              <View className="w-6 items-center">
                <Icon name={ic.name} size={18} color={ic.color} />
              </View>
              <Text muted className="w-8 text-right text-sm">
                {t(d.lowC)}°
              </Text>
              <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                <View
                  className="absolute h-full rounded-full"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(8, width)}%`,
                    backgroundColor: d.highC > 15 ? colors.warning : colors.primaryStrong,
                  }}
                />
              </View>
              <Text weight="bold" className="w-8 text-sm">
                {t(d.highC)}°
              </Text>
            </View>
          );
        })}
      </View>
    </GenCard>
  );
}
