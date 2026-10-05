import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import { hsl, hueFrom } from "@/lib/theme";
import { Text } from "./Text";

export function domainOf(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

/** Site favicon over a letter badge; the letter stays when the icon can't load. */
export function Favicon({ url, size = 20, ring }: { url: string; size?: number; ring?: boolean }) {
  const domain = domainOf(url);
  const hue = hueFrom(domain);
  const [failed, setFailed] = useState(false);
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
        overflow: "hidden",
      }}
    >
      <Text
        weight="bold"
        style={{ fontSize: size * 0.48, color: hsl(hue, 80, 78), lineHeight: size * 0.6 }}
      >
        {domain.charAt(0).toUpperCase()}
      </Text>
      {failed ? null : (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
          }}
          onError={() => setFailed(true)}
          cachePolicy="memory-disk"
          accessibilityIgnoresInvertColors
          style={{
            position: "absolute",
            width: size * 0.72,
            height: size * 0.72,
            borderRadius: size * 0.18,
          }}
        />
      )}
    </View>
  );
}
