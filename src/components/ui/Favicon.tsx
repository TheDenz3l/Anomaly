import { View } from "react-native";
import { hsl, hueFrom } from "@/lib/theme";
import { Text } from "./Text";

export function domainOf(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

/** Letter favicon — real favicons arrive with the backend; mock mode stays offline. */
export function Favicon({ url, size = 20, ring }: { url: string; size?: number; ring?: boolean }) {
  const domain = domainOf(url);
  const hue = hueFrom(domain);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hsl(hue, 45, 22),
        borderWidth: ring ? 2 : 0,
        borderColor: "#000",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        weight="bold"
        style={{ fontSize: size * 0.48, color: hsl(hue, 80, 78), lineHeight: size * 0.6 }}
      >
        {domain.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}
