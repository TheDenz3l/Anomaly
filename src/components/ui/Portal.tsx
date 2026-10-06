import { Fragment, useEffect, useId, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { create } from "zustand";

/**
 * Sheets render here, above every screen, instead of in a native Modal. There is no view
 * controller to present, so a sheet starts moving on the frame it is asked to, and one kept
 * mounted between uses opens without mounting anything. PortalHost goes once, after the navigator.
 */
const usePortals = create<{ nodes: ReadonlyMap<string, ReactNode> }>(() => ({ nodes: new Map() }));

/** How many overlays cover the screen right now. */
const useCovers = create<{ count: number }>(() => ({ count: 0 }));

function put(key: string, node: ReactNode | undefined) {
  const { nodes } = usePortals.getState();
  if (node === undefined ? !nodes.has(key) : nodes.get(key) === node) return;
  const next = new Map(nodes);
  if (node === undefined) next.delete(key);
  else next.set(key, node);
  usePortals.setState({ nodes: next });
}

/** Renders its children in the PortalHost; they keep their state as long as the Portal is mounted. */
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

/** Marks the screen as covered while `active`, e.g. by an open sheet. */
export function useCover(active: boolean) {
  useEffect(() => {
    if (!active) return;
    useCovers.setState((s) => ({ count: s.count + 1 }));
    return () => useCovers.setState((s) => ({ count: s.count - 1 }));
  }, [active]);
}

/** True while a sheet covers the screen; ambient animation holds still then. */
export function useCovered() {
  return useCovers((s) => s.count > 0);
}
