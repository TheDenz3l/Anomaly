import { Fragment, useEffect, useId, type ReactNode, useMemo, useRef } from "react";
import { StyleSheet, View, TextInput } from "react-native";
import { create } from "zustand";

/**
 * Sheets render here, above every screen, instead of in a native Modal. There is no view
 * controller to present, so a sheet starts moving on the frame it is asked to, and one kept
 * mounted between uses opens without mounting anything. PortalHost goes once, after the navigator.
 */
const usePortals = create<{ nodes: ReadonlyMap<string, ReactNode> }>(() => ({ nodes: new Map() }));

/** The window y of each open sheet's top edge, by sheet; null until the sheet is measured. */
const useCovers = create<{ tops: ReadonlyMap<string, number | null> }>(() => ({ tops: new Map() }));

function put(key: string, node: ReactNode | undefined) {
  const { nodes } = usePortals.getState();
  if (node === undefined ? !nodes.has(key) : nodes.get(key) === node) return;
  const next = new Map(nodes);
  if (node === undefined) next.delete(key);
  else next.set(key, node);
  usePortals.setState({ nodes: next });
}

export function Portal({ children }: { children: ReactNode }) {
  const key = useId();
  // Passive effects, not layout ones: React keeps them through a Suspense freeze, so a frozen
  // screen's sheet isn't torn down and rebuilt.
  useEffect(() => {
    put(key, children);
  });
  useEffect(() => () => put(key, undefined), [key]);
  return null;
}

type Field = ReturnType<typeof TextInput.State.currentlyFocusedInput>;
const fields = TextInput.State as Partial<typeof TextInput.State>;

/** The text field that has the keyboard, if any. Web only has the older name for it. */
function focusedField(): Field | null {
  return (
    fields.currentlyFocusedInput?.() ??
    (fields.currentlyFocusedField?.() as unknown as Field | undefined) ??
    null
  );
}

/**
 * An open overlay takes the keyboard, so nothing covers it, and gives it back to the field that
 * had it when it closes, so typing carries on where it stopped. A field focused inside the overlay
 * gives the keyboard up as it closes.
 */
export function useFocusHandoff() {
  const taken = useRef<Field | null>(null);
  return useMemo(
    () => ({
      take() {
        const field = focusedField();
        if (!field) return;
        taken.current = field;
        TextInput.State.blurTextInput(field);
      },
      /** `restore` false keeps the keyboard down, e.g. when the overlay closes to open a screen. */
      giveBack(restore: boolean) {
        const field = taken.current;
        taken.current = null;
        const own = focusedField();
        if (own && own !== field) TextInput.State.blurTextInput(own);
        if (field && restore) TextInput.State.focusTextInput(field);
      },
    }),
    []
  );
}

export function PortalHost() {
  const nodes = usePortals((s) => s.nodes);
  return (
    // The prop, not the style: web has no CSS value for box-none.
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {Array.from(nodes, ([key, node]) => (
        <Fragment key={key}>{node}</Fragment>
      ))}
    </View>
  );
}

/** Marks the screen as covered while `active` by a sheet whose top edge sits at window y `top`. */
export function useCover(active: boolean, top: number | null) {
  const key = useId();
  useEffect(() => {
    if (!active) return;
    useCovers.setState((s) => ({ tops: new Map(s.tops).set(key, top) }));
    return () =>
      useCovers.setState((s) => {
        const tops = new Map(s.tops);
        tops.delete(key);
        return { tops };
      });
  }, [active, key, top]);
}

/** The highest measured top edge among open sheets, or null while none covers the screen. */
export function useCoverTop() {
  return useCovers((s) => {
    let top: number | null = null;
    for (const t of s.tops.values()) if (t !== null && (top === null || t < top)) top = t;
    return top;
  });
}
