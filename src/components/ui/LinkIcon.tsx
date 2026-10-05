import { Image } from "expo-image";
import { useState } from "react";
import { Text as RNText, View } from "react-native";
import { domainOf } from "@/lib/links";
import { fonts, hsl, hueFrom } from "@/lib/theme";

/** Rounded-square site icon for inline links; a letter tile when the icon can't load. */
export function LinkIcon({ url, size = 17 }: { url: string; size?: number }) {
  const domain = domainOf(url);
  const hue = hueFrom(domain);
  const [failed, setFailed] = useState(false);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: failed ? hsl(hue, 45, 24) : "rgba(255,255,255,0.1)",
      }}
    >
      {failed ? (
        <RNText
          style={{
            fontFamily: fonts.bold,
            fontSize: size * 0.58,
            lineHeight: size * 0.75,
            color: hsl(hue, 80, 80),
          }}
        >
          {domain.charAt(0).toUpperCase()}
        </RNText>
      ) : (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
          }}
          onError={() => setFailed(true)}
          cachePolicy="memory-disk"
          contentFit="cover"
          accessibilityIgnoresInvertColors
          style={{ width: size, height: size }}
        />
      )}
    </View>
  );
}
