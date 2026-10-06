import { Platform, Text as RNText, StyleSheet, View } from "react-native";
import { LinkIcon } from "@/components/ui/LinkIcon";
import { domainOf, parseLinks, useLinkTitle, openLink } from "@/lib/links";
import { fonts } from "@/lib/theme";

const ICON = 17;

function LinkSpan({ title, url, color }: { title: string; url: string; color: string }) {
  const [, first = title, rest = ""] = title.match(/^(\S*)([\s\S]*)$/) ?? [];
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={() => void openLink(url)}
      style={{ color, fontFamily: fonts.bold }}
    >
      <RNText style={styles.keep}>
        <View style={styles.slot} importantForAccessibility="no-hide-descendants">
          <View style={styles.icon}>
            <LinkIcon url={url} size={ICON} />
          </View>
        </View>
        {"\u00A0"}
        {first}
      </RNText>
      {rest}
    </RNText>
  );
}

function BareLink({ url, color }: { url: string; color: string }) {
  const title = useLinkTitle(url);
  return <LinkSpan title={title || domainOf(url)} url={url} color={color} />;
}

/** Text with each link drawn as the site's icon and the page title. Render inside a Text. */
export function LinkedText({ text, color }: { text: string; color: string }) {
  return parseLinks(text).map((s, i) =>
    s.type === "text" ? (
      s.text
    ) : s.title ? (
      <LinkSpan key={i} title={s.title} url={s.url} color={color} />
    ) : (
      <BareLink key={i} url={s.url} color={color} />
    )
  );
}

const styles = StyleSheet.create({
  /** The icon, its no-break space and the first word wrap as one; web breaks after inline boxes otherwise. */
  keep: (Platform.OS === "web" ? { whiteSpace: "nowrap" } : {}) as object,
  slot: { width: ICON + 1, height: ICON - 4 },
  icon: { position: "absolute", left: 0, top: 0 },
});
