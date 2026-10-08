import { useRef, useState } from "react";
import { Alert, Platform, TextInput } from "react-native";
import { FormSheet } from "@/components/ui/FormSheet";
import { Text } from "@/components/ui/Text";
import { colors, fonts } from "@/lib/theme";

export const INSTRUCTIONS_MAX = 1500;

/** Full-height editor for custom instructions: write, then Save puts them on the settings card. */
export function InstructionsSheet({
  open,
  onClose,
  value,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(value);
  }
  const input = useRef<TextInput>(null);
  const changed = draft.trim() !== value.trim();
  const near = draft.length > INSTRUCTIONS_MAX * 0.9;

  const close = () => {
    if (!changed) return onClose();
    // Alert.alert does nothing on web (react-native-web stubs it).
    if (Platform.OS === "web") {
      const ask = (globalThis as { confirm?: (text: string) => boolean }).confirm;
      if (!ask || ask("Discard your changes?\n\nYour edits to the instructions won't be saved."))
        onClose();
      return;
    }
    Alert.alert("Discard your changes?", "Your edits to the instructions won't be saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onClose },
    ]);
  };

  return (
    <FormSheet
      open={open}
      onClose={close}
      title="Custom instructions"
      fill
      leading={{ label: "Cancel", icon: "close", onPress: close }}
      confirm={{
        label: "Save",
        icon: "checkmark",
        disabled: !changed,
        onPress: () => {
          onSave(draft.trim());
          onClose();
        },
      }}
      onShown={() => input.current?.focus()}
    >
      <Text muted className="px-1 pb-2 text-[13px] leading-[18px]">
        Added to every conversation, separate from memory.
      </Text>
      <TextInput
        ref={input}
        value={draft}
        onChangeText={setDraft}
        multiline
        maxLength={INSTRUCTIONS_MAX}
        placeholder="How should Anomaly respond? What should it know about you?"
        placeholderTextColor={colors.textFaint}
        accessibilityLabel="Custom instructions"
        style={{
          flex: 1,
          fontFamily: fonts.body,
          fontSize: 17,
          lineHeight: 24,
          color: colors.text,
          paddingHorizontal: 4,
          paddingTop: 6,
          textAlignVertical: "top",
        }}
      />
      <Text
        className="pt-2 text-right text-xs"
        style={{ color: near ? colors.warning : colors.textFaint }}
      >
        {`${draft.length} / ${INSTRUCTIONS_MAX}`}
      </Text>
    </FormSheet>
  );
}
