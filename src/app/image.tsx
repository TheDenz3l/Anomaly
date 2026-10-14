import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { useImageActions } from "@/lib/imageFile";

/** Room the top and bottom controls take, so the picture fits between them. */
const CHROME = 128;

function Action({
  icon,
  label,
  busy,
  onPress,
}: {
  icon: IconName;
  label: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Tap accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={busy}>
      <Glass radius={22} interactive>
        <View className="h-11 flex-row items-center gap-2 px-5">
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Icon name={icon} size={18} color="#fff" />
          )}
          <Text weight="medium" className="text-[15px]">
            {label}
          </Text>
        </View>
      </Glass>
    </Tap>
  );
}

/** A generated image on its own: full screen, pinch to zoom, share it or save it to Photos. */
export default function ImageScreen() {
  const params = useLocalSearchParams<{
    url: string;
    title?: string;
    mime?: string;
    w?: string;
    h?: string;
  }>();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const [ratio, setRatio] = useState(() => {
    const w = Number(params.w);
    const h = Number(params.h);
    return w > 0 && h > 0 ? w / h : 0;
  });
  const { save, share, busy } = useImageActions(params.url, params.mime || undefined, params.title);

  const roomH = screen.height - insets.top - insets.bottom - CHROME;
  const fitW = ratio ? Math.min(screen.width, roomH * ratio) : screen.width;
  const fitH = ratio ? fitW / ratio : roomH;
  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

  return (
    <View style={styles.page}>
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{
          width: screen.width,
          height: screen.height,
          alignItems: "center",
          justifyContent: "center",
        }}
        maximumZoomScale={4}
        minimumZoomScale={1}
        bouncesZoom
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      >
        <Image
          source={{ uri: params.url }}
          contentFit="contain"
          cachePolicy="memory-disk"
          accessible
          accessibilityLabel={params.title || "Generated image"}
          accessibilityIgnoresInvertColors
          onLoad={(e) => {
            const { width, height } = e.source;
            if (!ratio && width && height) setRatio(width / height);
          }}
          style={{ width: fitW, height: fitH }}
        />
      </ScrollView>

      <View
        pointerEvents="box-none"
        style={[styles.top, { paddingTop: insets.top + 6 }]}
        className="flex-row items-center gap-3 px-3"
      >
        <Tap accessibilityRole="button" accessibilityLabel="Close" onPress={close}>
          <Glass radius={20} interactive>
            <View className="h-10 w-10 items-center justify-center">
              <Icon name="close" size={20} color="#fff" />
            </View>
          </Glass>
        </Tap>
        <Text weight="medium" numberOfLines={1} className="flex-1 text-center text-[15px]">
          {params.title ?? ""}
        </Text>
        <View className="h-10 w-10" />
      </View>

      <View
        pointerEvents="box-none"
        style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}
        className="flex-row justify-center gap-3"
      >
        <Action
          icon="share-outline"
          label="Share"
          busy={busy === "share"}
          onPress={() => void share()}
        />
        <Action
          icon="download-outline"
          label="Save"
          busy={busy === "save"}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  top: { position: "absolute", top: 0, left: 0, right: 0 },
  bottom: { position: "absolute", bottom: 0, left: 0, right: 0 },
});
