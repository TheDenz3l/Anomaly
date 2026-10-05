import { StyleSheet, View } from "react-native";
import { colors } from "@/lib/theme";

/** Three lines. Stays a menu glyph while the side menu is open; the chat card closes it. */
export function MenuGlyph() {
  return (
    <View style={styles.box}>
      <View style={styles.line} />
      <View style={[styles.line, styles.short]} />
      <View style={styles.line} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 18, height: 14.5, justifyContent: "space-between" },
  line: { width: 18, height: 1.5, borderRadius: 1, backgroundColor: colors.text },
  short: { width: 13 },
});
