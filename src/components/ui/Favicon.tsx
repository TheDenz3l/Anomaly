import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import { domainOf } from "@/lib/links";
import { hsl, hueFrom } from "@/lib/theme";
import { Text } from "./Text";

/**
 * Site favicon over a letter badge; the letter stays when the icon can't load. `fill` lets the icon
 * cover the whole circle, for sizes too small to inset it.
 */
export function Favicon({
  url,
  size = 20,
  ring,
  fill,
}: {
  url: string;
  size?: number;
  ring?: boolean;
  fill?: boolean;
}) {
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
            width: fill ? size : size * 0.72,
            height: fill ? size : size * 0.72,
            borderRadius: fill ? size / 2 : size * 0.18,
          }}
        />
      )}
    </View>
  );
}
