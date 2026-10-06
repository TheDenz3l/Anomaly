import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { Composer } from "@/components/chat/Composer";
import { EmptyState } from "@/components/chat/EmptyState";
import { AssistantMessage, UserMessage } from "@/components/chat/Messages";
import { NavPanel } from "@/components/navigation/NavPanel";
import { SideDrawer } from "@/components/navigation/SideDrawer";
import { Glass } from "@/components/ui/Glass";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { bubbleIn, popIn, popOut, replyIn, threadIn } from "@/lib/motion";
import { useApp } from "@/lib/store";
import {
  KeyboardChatScrollView,
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { setChatVisible } from "@/lib/haptics";

/** Distance from the bottom (px) beyond which we stop following new content and offer a jump button. */
const FOLLOW_SLACK = 140;

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const threadId = useApp((s) => s.activeThreadId);
  const messages = useApp((s) => (s.activeThreadId ? s.messages[s.activeThreadId] : undefined));
  const [composerH, setComposerH] = useState(110);
  const [away, setAway] = useState(false);
  const scroller = useRef<Animated.ScrollView>(null);
  const stick = useRef(true);
  /** Until then, layout growth (a thread loading, images settling) keeps the view pinned to the end. */
  const settleUntil = useRef(0);
  /** A smooth scroll is in flight; jumping now would cut it short. */
  const smoothUntil = useRef(0);
  const count = messages?.length ?? 0;
  const bottom = Math.max(insets.bottom, 12);
  // With the keyboard up the composer rides 8pt above it; the home-indicator gap slides under.
  const keyboardOffset = bottom - 8;
  const kb = useReanimatedKeyboardAnimation();
  // Keep the empty-state orb centred in the space left between the header and the composer.
  const recentre = useAnimatedStyle(
    () => ({
      transform: [{ translateY: (kb.height.value + keyboardOffset * kb.progress.value) / 2 }],
    }),
    [keyboardOffset]
  );

  // Reply haptics only play while the chat is on screen.
  useFocusEffect(
    useCallback(() => {
      setChatVisible(true);
      return () => setChatVisible(false);
    }, [])
  );

  // Switching chats remounts the conversation (one settle-in animation) and marks the messages that were
  // already there, so only messages that arrive afterwards animate in. Sending the first message of a new
  // chat continues the same view rather than counting as a switch.
  const [tracked, setTracked] = useState(threadId);
  const [generation, setGeneration] = useState(0);
  const [existing, setExisting] = useState(() => new Set(messages?.map((m) => m.key ?? m.id)));
  if (tracked !== threadId) {
    setTracked(threadId);
    // A new chat's first send goes null → pending → real id; all three are the same conversation.
    const continuing = (tracked === null && count <= 2) || Boolean(tracked?.startsWith("pending_"));
    if (!continuing) {
      setGeneration((g) => g + 1);
      setExisting(new Set(messages?.map((m) => m.key ?? m.id)));
    }
  }

  // A sent message is parked just under the header, with the reply filling the space below it
  // (ChatGPT-style). Blank space past the end of the content (a scroll inset, not layout) makes
  // room for that even while the reply is still short.
  const blank = useSharedValue(0);
  const viewH = useRef(0);
  const contentH = useRef(0);
  /** Where each user message sits in the conversation, by key. */
  const userY = useRef(new Map<string, number>());
  const anchor = useRef<string | null>(null);
  const parkPending = useRef(false);
  let latestUser: string | null = null;
  let latestUserAt = 0;
  for (let i = count - 1; i >= 0 && messages; i--) {
    if (messages[i].role === "user") {
      latestUser = messages[i].key ?? messages[i].id;
      latestUserAt = messages[i].createdAt;
      break;
    }
  }

  const syncBlank = () => {
    const y = anchor.current ? userY.current.get(anchor.current) : undefined;
    blank.set(y === undefined ? 0 : Math.max(0, y + viewH.current - contentH.current));
  };

  const park = () => {
    const y = anchor.current ? userY.current.get(anchor.current) : undefined;
    if (!parkPending.current || y === undefined) return;
    parkPending.current = false;
    syncBlank();
    // Two frames: the blank inset lands before the scroll that needs it.
    const go = () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          smoothUntil.current = Date.now() + 500;
          scroller.current?.scrollTo({
            y: userY.current.get(anchor.current ?? "") ?? y,
            animated: true,
          });
        })
      );
    if (!Keyboard.isVisible()) return go();
    // Let the keyboard finish closing first, so its own offset change doesn't fight the scroll.
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      sub.remove();
      go();
    };
    const sub = Keyboard.addListener("keyboardDidHide", once);
    setTimeout(once, 700);
  };

  useEffect(() => {
    anchor.current = null;
    parkPending.current = false;
    userY.current.clear();
    blank.set(0);
  }, [generation, blank]);

  useEffect(() => {
    // Only a message just sent parks the view; history arriving after a switch doesn't.
    if (!latestUser || existing.has(latestUser) || Date.now() - latestUserAt > 15_000) return;
    // Stop following the end and park the new message instead.
    stick.current = false;
    anchor.current = latestUser;
    parkPending.current = true;
    park();
    // park reads refs only; it must not re-run when its identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestUser, existing]);

  useEffect(() => {
    // A send in this chat parks the view itself.
    if (anchor.current) return;
    stick.current = threadId !== null;
    settleUntil.current = Date.now() + 1500;
    requestAnimationFrame(() => {
      if (threadId) scroller.current?.scrollToEnd({ animated: false });
      else scroller.current?.scrollTo({ y: 0, animated: false });
    });
  }, [threadId]);

  const jumpToLatest = () => {
    stick.current = true;
    scroller.current?.scrollToEnd({ animated: true });
  };

  return (
    <SideDrawer panel={<NavPanel />}>
      <View className="flex-1 bg-background">
        <KeyboardChatScrollView
          ref={scroller}
          // ChatGPT-style: lift the conversation with the keyboard only when reading the latest
          // message. The empty state recentres itself instead of scrolling away.
          keyboardLiftBehavior={count === 0 ? "never" : "whenAtEnd"}
          offset={keyboardOffset}
          blankSpace={blank}
          // A new chat is a fixed screen, not a list: the keyboard inset must not make the orb
          // draggable. Tapping the empty space still puts the keyboard away.
          scrollEnabled={count > 0}
          showsVerticalScrollIndicator={count > 0}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onLayout={(e) => {
            viewH.current = e.nativeEvent.layout.height;
            syncBlank();
          }}
          onScroll={(e) => {
            if (Date.now() < smoothUntil.current) return;
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            // The end includes the blank space a parked send leaves below the reply.
            const distance =
              contentSize.height + blank.get() - contentOffset.y - layoutMeasurement.height;
            stick.current = !anchor.current && distance < FOLLOW_SLACK;
            const isAway = count > 0 && distance > FOLLOW_SLACK * 2;
            if (isAway !== away) setAway(isAway);
          }}
          scrollEventThrottle={32}
          onContentSizeChange={(_, h) => {
            contentH.current = h;
            syncBlank();
            // Follow new content while a thread settles in. A parked send stays put while the
            // reply streams below it; growth the user caused (opening a thinking block,
            // expanding a card) never drags the view either.
            const now = Date.now();
            if (anchor.current || !stick.current || count === 0 || now < smoothUntil.current)
              return;
            if (useApp.getState().streaming || now < settleUntil.current)
              scroller.current?.scrollToEnd({ animated: false });
          }}
          contentContainerStyle={{
            flexGrow: 1,
            width: "100%",
            maxWidth: 720,
            alignSelf: "center",
            paddingTop: insets.top + 68,
            paddingBottom: composerH + bottom + 28,
            paddingHorizontal: 18,
          }}
        >
          <Animated.View key={generation} entering={threadIn} style={{ flexGrow: 1, gap: 22 }}>
            {messages && messages.length > 0 ? (
              messages.map((m, i) => {
                const key = m.key ?? m.id;
                return (
                  <Animated.View
                    key={key}
                    entering={
                      existing.has(key) ? undefined : m.role === "user" ? bubbleIn : replyIn
                    }
                    onLayout={
                      m.role === "user"
                        ? (e) => {
                            userY.current.set(key, e.nativeEvent.layout.y);
                            if (key !== anchor.current) return;
                            syncBlank();
                            park();
                          }
                        : undefined
                    }
                  >
                    {m.role === "user" ? (
                      <UserMessage message={m} />
                    ) : (
                      <AssistantMessage message={m} last={i === messages.length - 1} />
                    )}
                  </Animated.View>
                );
              })
            ) : (
              <Animated.View style={[{ flexGrow: 1 }, recentre]}>
                <EmptyState />
              </Animated.View>
            )}
          </Animated.View>
        </KeyboardChatScrollView>

        <ChatHeader />

        <KeyboardStickyView
          offset={{ opened: keyboardOffset }}
          pointerEvents="box-none"
          style={{ position: "absolute", alignSelf: "center", bottom: composerH + bottom + 12 }}
        >
          {away ? (
            <Animated.View entering={popIn} exiting={popOut}>
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Jump to latest"
                onPress={jumpToLatest}
              >
                <Glass radius={20} interactive>
                  <View className="h-10 w-10 items-center justify-center">
                    <Icon name="arrow-down" size={18} />
                  </View>
                </Glass>
              </Tap>
            </Animated.View>
          ) : null}
        </KeyboardStickyView>

        <KeyboardStickyView
          offset={{ opened: keyboardOffset }}
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          <View
            style={{ paddingBottom: bottom, width: "100%", maxWidth: 720, alignSelf: "center" }}
            pointerEvents="box-none"
          >
            <Composer onLayout={(e) => setComposerH(e.nativeEvent.layout.height)} />
          </View>
        </KeyboardStickyView>
      </View>
    </SideDrawer>
  );
}
