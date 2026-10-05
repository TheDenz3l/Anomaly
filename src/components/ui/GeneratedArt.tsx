import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { hsl, hueFrom } from "@/lib/theme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

/**
 * Deterministic artwork for product tiles and movies without a TMDB poster;
 * product images replace this once the backend proxies them.
 */
export function GeneratedArt({
  seed,
  width,
  height,
  title,
  caption,
  icon,
  radius = 16,
}: {
  seed: string;
  width: number | `${number}%`;
  height: number;
  title?: string;
  caption?: string;
  icon?: IconName;
  radius?: number;
}) {
  const h = hueFrom(seed);
  const h2 = (h + 48) % 360;
  const id = `g${h}`;
  const shape = h % 3;
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius,
        overflow: "hidden",
        backgroundColor: hsl(h, 35, 12),
      }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 100 140"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "absolute" }}
      >
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor={hsl(h, 60, 34)} />
            <Stop offset="1" stopColor={hsl(h2, 55, 8)} />
          </LinearGradient>
        </Defs>
        <Rect width="100" height="140" fill={`url(#${id})`} />
        {shape === 0 ? <Circle cx="70" cy="42" r="30" fill={hsl(h2, 70, 60, 0.35)} /> : null}
        {shape === 1 ? (
          <Path
            d="M0 98 L38 52 L62 80 L82 60 L100 76 L100 140 L0 140 Z"
            fill={hsl(h2, 45, 6, 0.75)}
          />
        ) : null}
        {shape === 2 ? (
          <Path d="M-10 30 Q50 70 110 20 L110 60 Q50 110 -10 70 Z" fill={hsl(h2, 70, 55, 0.25)} />
        ) : null}
        <Rect y="90" width="100" height="50" fill="rgba(0,0,0,0.35)" />
      </Svg>
      {icon ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={36} color={hsl(h, 70, 85, 0.9)} />
        </View>
      ) : null}
      {title ? (
        <View style={{ position: "absolute", left: 10, right: 10, bottom: 10 }}>
          <Text weight="bold" className="text-[13px] leading-4 text-white" numberOfLines={3}>
            {title}
          </Text>
          {caption ? (
            <Text className="mt-0.5 text-[11px] text-white/70" numberOfLines={1}>
              {caption}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
