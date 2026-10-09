import { useLayoutEffect, useMemo, useRef } from "react";
import { GenSkeleton, type GenProps } from "@/genui/kit";
import type { CardStateEntry } from "@/genui/schemas";
import { api, convex, type Id } from "@/lib/convex";
import { openLink } from "@/lib/links";
import { useApp } from "@/lib/store";
import { nativeLibrary } from "./components";
import { OpenUIRenderer, type OpenUIHandlers } from "./runtime";

/** A preview draws the card as it was saved: nothing it shows comes from a live fetch. */
const notLive = () => Promise.reject(new Error("Live data shows when the card is open."));

/**
 * An answer the model wrote in OpenUI Lang, drawn natively as it streams. Taps that talk to the
 * assistant arrive as the user's next message; Query(…) data comes from the card tools on the
 * server; what the user sets on it is saved with it, so it's the same next time.
 */
export function OpenUI({ props, building = false, busy, card }: GenProps<"OpenUI">) {
  const send = useApp((s) => s.send);
  const busyRef = useRef(busy);
  useLayoutEffect(() => {
    busyRef.current = busy;
  });
  const live = Boolean(card);
  const handlers = useMemo<OpenUIHandlers>(
    () => ({
      toAssistant: (message) => {
        if (live && !busyRef.current && message.trim()) send(message, []);
      },
      openUrl: (url) => void openLink(url),
      callTool: live ? (name, args) => convex.action(api.cardTools.call, { name, args }) : notLive,
    }),
    [send, live]
  );
  const threadId = card?.threadId;
  const partId = card?.partId;
  const save = useMemo(
    () =>
      threadId && partId
        ? (state: CardStateEntry[]) =>
            void convex
              .mutation(api.messages.saveCardState, {
                threadId: threadId as Id<"threads">,
                componentId: partId,
                state,
              })
              // Losing one save costs the user a slider position, not the chat: no toast.
              .catch(() => {})
        : undefined,
    [threadId, partId]
  );
  return (
    <OpenUIRenderer
      source={props.source}
      library={nativeLibrary}
      streaming={building}
      handlers={handlers}
      photos={props.photos}
      photosDone={props.photosDone}
      initialState={props.state}
      onStateChange={save}
      placeholder={building ? <GenSkeleton name="OpenUI" /> : null}
    />
  );
}
