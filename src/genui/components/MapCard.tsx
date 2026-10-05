import { useState } from "react";
import { View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, GenCard, type GenProps } from "@/genui/kit";
import { colors, fonts } from "@/lib/theme";

const H = 210;

/**
 * Stylised vector map that works offline and on web. MapLibre + OSM tiles replace the SVG layer
 * in the native build; the pin ↔ list sync stays the same.
 */
export function MapCard({ props, emit, busy }: GenProps<"MapCard">) {
  const [w, setW] = useState(0);
  const [selected, setSelected] = useState(props.places[0].id);
  const all = [...props.places, { id: "__home", lat: props.center.lat, lng: props.center.lng }];
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const pad = 0.18;
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
  const dLat = (maxLat - minLat || 0.01) * (1 + pad * 2);
  const dLng = (maxLng - minLng || 0.01) * (1 + pad * 2);
  const x = (lng: number) => ((lng - (minLng - (maxLng - minLng) * pad)) / dLng) * w;
  const y = (lat: number) => H - ((lat - (minLat - (maxLat - minLat) * pad)) / dLat) * H;
  const place = props.places.find((p) => p.id === selected) ?? props.places[0];

  // Toronto's street grid runs about 17° off true north — the map leans with it.
  const streets = Array.from({ length: 16 }, (_, i) => i);

  return (
    <GenCard
      title={props.title ?? "Map"}
      subtitle={`Around ${props.center.label}`}
      icon="map-outline"
      flush
    >
      <View
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        style={{ height: H, backgroundColor: "#0D0D10" }}
      >
        {w > 0 ? (
          <Svg width={w} height={H}>
            <G transform={`rotate(-17 ${w / 2} ${H / 2})`}>
              {streets.map((i) => (
                <Line
                  key={`v${i}`}
                  x1={-w * 0.3 + (i * w * 1.6) / 15}
                  y1={-H}
                  x2={-w * 0.3 + (i * w * 1.6) / 15}
                  y2={H * 2}
                  stroke={i % 5 === 2 ? "#2B2B33" : "#1A1A1F"}
                  strokeWidth={i % 5 === 2 ? 4 : 1.5}
                />
              ))}
              {streets.map((i) => (
                <Line
                  key={`h${i}`}
                  x1={-w}
                  y1={-H * 0.4 + (i * H * 1.8) / 15}
                  x2={w * 2}
                  y2={-H * 0.4 + (i * H * 1.8) / 15}
                  stroke={i % 4 === 1 ? "#2B2B33" : "#1A1A1F"}
                  strokeWidth={i % 4 === 1 ? 4 : 1.5}
                />
              ))}
              <Rect
                x={w * 0.62}
                y={H * 0.08}
                width={w * 0.12}
                height={H * 0.22}
                rx={6}
                fill="#0F1F17"
              />
            </G>
            <Path
              d={`M0 ${H * 0.86} C ${w * 0.3} ${H * 0.8}, ${w * 0.6} ${H * 0.92}, ${w} ${H * 0.84} L ${w} ${H} L 0 ${H} Z`}
              fill="#0B1729"
            />
            <Circle
              cx={x(props.center.lng)}
              cy={y(props.center.lat)}
              r={16}
              fill="rgba(59,130,246,0.18)"
            />
            <Circle
              cx={x(props.center.lng)}
              cy={y(props.center.lat)}
              r={6}
              fill={colors.primary}
              stroke="#fff"
              strokeWidth={2}
            />
            {props.places.map((p, i) => {
              const on = p.id === selected;
              return (
                <G key={p.id}>
                  <Circle
                    cx={x(p.lng)}
                    cy={y(p.lat)}
                    r={on ? 14 : 11}
                    fill={on ? colors.primary : colors.raised}
                    stroke={on ? "#fff" : "#52525B"}
                    strokeWidth={on ? 2 : 1}
                  />
                  <SvgText
                    x={x(p.lng)}
                    y={y(p.lat) + 4}
                    fontSize={on ? 12 : 11}
                    fontFamily={fonts.bold}
                    fontWeight="700"
                    fill="#fff"
                    textAnchor="middle"
                  >
                    {String(i + 1)}
                  </SvgText>
                </G>
              );
            })}
          </Svg>
        ) : null}
        {w > 0
          ? props.places.map((p) => (
              <Tap
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={`Pin: ${p.name}`}
                onPress={() => setSelected(p.id)}
                style={{
                  position: "absolute",
                  left: x(p.lng) - 18,
                  top: y(p.lat) - 18,
                  width: 36,
                  height: 36,
                }}
              />
            ))
          : null}
        <View pointerEvents="none" className="absolute bottom-2 right-3">
          <Text className="text-[10px] text-white/50">© OpenStreetMap contributors</Text>
        </View>
      </View>

      <View className="py-1">
        {props.places.map((p, i) => {
          const on = p.id === selected;
          return (
            <Tap
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setSelected(p.id)}
              className={`mx-2 flex-row items-center gap-3 rounded-2xl px-2 py-2.5 ${on ? "bg-raised" : ""}`}
            >
              <View
                className={`h-7 w-7 items-center justify-center rounded-full ${on ? "bg-primary" : "bg-raised"}`}
              >
                <Text weight="bold" className="text-xs">
                  {i + 1}
                </Text>
              </View>
              <View className="flex-1">
                <Text weight={on ? "bold" : "medium"} className="text-[15px]" numberOfLines={1}>
                  {p.name}
                </Text>
                {p.subtitle ? (
                  <Text muted className="text-[13px]" numberOfLines={1}>
                    {p.subtitle}
                  </Text>
                ) : null}
              </View>
              {p.distanceKm !== undefined ? (
                <Text muted weight="medium" className="text-[13px]">
                  {p.distanceKm} km
                </Text>
              ) : null}
            </Tap>
          );
        })}
      </View>
      <View className="flex-row items-center gap-2 border-t border-hairline px-4 py-3">
        <Icon name="walk-outline" size={16} color={colors.textMuted} />
        <Text muted className="flex-1 text-[13px]">
          About {Math.max(1, Math.round((place.distanceKm ?? 1) * 12))} min walk to {place.name}
        </Text>
        <ActionButton
          size="sm"
          variant="secondary"
          label="Directions"
          disabled={busy}
          onPress={() =>
            emit("directions", `Directions to ${place.name}`, {
              place: place.name,
              minutes: Math.max(1, Math.round((place.distanceKm ?? 1) * 12)),
            })
          }
        />
      </View>
    </GenCard>
  );
}
