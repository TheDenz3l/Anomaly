import { Image } from "expo-image";
import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { openLink, useLinkTitle } from "@/lib/links";
import { colors } from "@/lib/theme";

export type ImageRef = { url: string; alt: string };

const YOUTUBE =
  /(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** The video id when a URL points at a YouTube video. */
export function youtubeId(url: string): string | null {
  return url.match(YOUTUBE)?.[1] ?? null;
}

/** Image files linked bare, on their own. */
export const IMAGE_URL = /^https?:\/\/\S+\.(?:png|jpe?g|webp|gif|avif)(?:\?\S*)?$/i;

/** Chat content runs this far from the screen edge; galleries scroll out to it. */
const GUTTER = 18;
const ROW_H = 200;
const RADIUS = 22;

function GalleryImage({
  image,
  height,
  width,
  onFail,
}: {
  image: ImageRef;
  height: number;
  width?: number;
  onFail: () => void;
}) {
  const [ratio, setRatio] = useState(4 / 3);
  return (
    <Tap
      accessibilityRole="imagebutton"
      accessibilityLabel={image.alt || "Image"}
      accessibilityHint="Opens the image"
      onPress={() => void openLink(image.url)}
    >
      <Image
        source={{ uri: image.url }}
        onLoad={(e) => {
          const { width: w, height: h } = e.source;
          if (w && h) setRatio(w / h);
        }}
        onError={onFail}
        contentFit="cover"
        transition={180}
        cachePolicy="memory-disk"
        accessibilityIgnoresInvertColors
        style={[
          styles.image,
          width
            ? { width, height: Math.min(height, width / ratio) }
            : { height, width: Math.min(300, Math.max(140, height * ratio)) },
        ]}
      />
    </Tap>
  );
}

/** Photos from a reply: one fills the width; several scroll sideways, past the text margin. */
export function ImageGallery({ images }: { images: ImageRef[] }) {
  const { width } = useWindowDimensions();
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const shown = images.filter((i) => !failed.has(i.url));
  if (shown.length === 0) return null;
  const fail = (url: string) => setFailed((f) => new Set(f).add(url));
  if (shown.length === 1) {
    return (
      <GalleryImage
        image={shown[0]}
        width={Math.min(width, 720) - GUTTER * 2}
        height={360}
        onFail={() => fail(shown[0].url)}
      />
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -GUTTER }}
      contentContainerStyle={{ gap: 10, paddingHorizontal: GUTTER }}
    >
      {shown.map((image) => (
        <GalleryImage key={image.url} image={image} height={ROW_H} onFail={() => fail(image.url)} />
      ))}
    </ScrollView>
  );
}

/** A YouTube link as a playable card: thumbnail, title, and the in-app player on tap. */
export function VideoCard({ id, url, label }: { id: string; url: string; label: string }) {
  const fetched = useLinkTitle(url);
  const [thumb, setThumb] = useState(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  const generic = !label || /^(https?:|www\.|watch|video|here|link|youtube)/i.test(label.trim());
  const title = fetched?.replace(/\s*[-–]\s*YouTube\s*$/i, "") || (generic ? null : label);
  return (
    <Tap
      accessibilityRole="link"
      accessibilityLabel={`${title ?? "Video"}, YouTube`}
      accessibilityHint="Plays the video"
      onPress={() => void openLink(`https://www.youtube.com/watch?v=${id}`)}
      style={styles.card}
    >
      <View>
        <Image
          source={{ uri: thumb }}
          onError={() => setThumb(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`)}
          contentFit="cover"
          transition={180}
          cachePolicy="memory-disk"
          accessibilityIgnoresInvertColors
          style={styles.thumb}
        />
        <View pointerEvents="none" style={styles.playWrap}>
          <View style={styles.play}>
            <Icon name="play" size={24} color="#fff" />
          </View>
        </View>
      </View>
      <View className="gap-1 px-4 py-3">
        {title ? (
          <Text weight="medium" className="text-[15px] leading-5" numberOfLines={2}>
            {title}
          </Text>
        ) : null}
        <View className="flex-row items-center gap-1.5">
          <Icon name="logo-youtube" size={14} color={colors.textMuted} />
          <Text muted className="text-[13px]">
            YouTube
          </Text>
        </View>
      </View>
    </Tap>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: RADIUS, backgroundColor: colors.surface },
  card: { borderRadius: RADIUS, overflow: "hidden", backgroundColor: colors.surface },
  thumb: { width: "100%", aspectRatio: 16 / 9, backgroundColor: colors.raised },
  playWrap: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  play: {
    width: 64,
    height: 44,
    borderRadius: 14,
    backgroundColor: "#FF0033",
    alignItems: "center",
    justifyContent: "center",
  },
});
