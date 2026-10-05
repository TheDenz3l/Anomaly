import { useEffect, useRef } from "react";
import { View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { ActionButton, Pill, type GenProps } from "@/genui/kit";
import { useApp } from "@/lib/store";
import { colors } from "@/lib/theme";

/** Inline, just-in-time location prompt (PRD §7: requested only when needed). */
export function LocationRequest({ props, emit, events, busy }: GenProps<"LocationRequest">) {
  const done = events.at(-1);
  return (
    <View className="flex-row items-center gap-3 rounded-3xl bg-card p-4">
      <View className="h-10 w-10 items-center justify-center rounded-full bg-primary-soft">
        <Icon name="navigate" size={18} color={colors.primaryStrong} />
      </View>
      <View className="flex-1 gap-2">
        <View>
          <Text weight="bold" className="text-[15px]">
            {props.reason}
          </Text>
          <Text muted className="text-[13px] leading-[18px]">
            Used once for this answer. Never saved to memory.
          </Text>
        </View>
        {done ? (
          <Pill label={done.label} tone="success" icon="checkmark" />
        ) : (
          <View className="flex-row flex-wrap gap-2">
            <ActionButton
              size="sm"
              label="Allow location"
              disabled={busy}
              onPress={() => emit("allow", "Shared current location")}
            />
            <ActionButton
              size="sm"
              variant="secondary"
              label={`Use ${props.fallbackCity}`}
              disabled={busy}
              onPress={() =>
                emit("city", `Using ${props.fallbackCity}`, { city: props.fallbackCity })
              }
            />
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * Memory write gate (PRD §3.9). High confidence auto-saves with undo; mid confidence asks inline.
 */
export function MemoryConfirm({ props, emit, events, live }: GenProps<"MemoryConfirm">) {
  const addMemory = useApp((s) => s.addMemory);
  const deleteMemory = useApp((s) => s.deleteMemory);
  const last = events.at(-1);
  const memoryId = events.find((e) => e.payload?.memoryId)?.payload?.memoryId as string | undefined;
  const saved = last?.action === "save" || last?.action === "auto_saved";
  const auto = props.confidence > 0.85;
  const autoSaved = useRef(false);

  useEffect(() => {
    if (auto && live && events.length === 0 && !autoSaved.current) {
      autoSaved.current = true;
      const id = addMemory({
        text: props.text,
        category: props.category,
        scope: props.scope,
        confidence: props.confidence,
      });
      emit("auto_saved", "Saved to memory", { memoryId: id });
    }
  }, [auto, live, events.length, addMemory, emit, props]);

  const save = () => {
    const id = addMemory({
      text: props.text,
      category: props.category,
      scope: props.scope,
      confidence: props.confidence,
    });
    emit("save", "Saved to memory", { memoryId: id });
  };

  return (
    <View className="flex-row items-center gap-3 rounded-3xl border border-raised p-3.5">
      <Icon name="sparkles" size={18} color={saved ? colors.primary : colors.textMuted} />
      <View className="flex-1">
        <Text weight="medium" className="text-[15px] leading-5">
          {props.text}
        </Text>
        <Text muted className="text-xs">
          {saved
            ? "Saved to memory"
            : last?.action === "undo"
              ? "Removed"
              : last?.action === "dismiss"
                ? "Not saved"
                : `${Math.round(props.confidence * 100)}% sure this is worth keeping`}
        </Text>
      </View>
      {saved ? (
        <ActionButton
          size="sm"
          variant="ghost"
          label="Undo"
          onPress={() => {
            if (memoryId) deleteMemory(memoryId);
            emit("undo", "Removed from memory");
          }}
        />
      ) : !last ? (
        <View className="flex-row gap-1.5">
          <ActionButton
            size="sm"
            variant="ghost"
            label="Not now"
            onPress={() => emit("dismiss", "Didn't save to memory")}
          />
          <ActionButton size="sm" label="Remember" onPress={save} />
        </View>
      ) : null}
    </View>
  );
}
