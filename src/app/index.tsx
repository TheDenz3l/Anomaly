import { useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";
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

function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/** Distance from the bottom (px) beyond which we stop following new content and offer a jump button. */
const FOLLOW_SLACK = 140;

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const threadId = useApp((s) => s.activeThreadId);
  const messages = useApp((s) => (s.activeThreadId ? s.messages[s.activeThreadId] : undefined));
  const keyboard = useKeyboardVisible();
  const [composerH, setComposerH] = useState(110);
  const [away, setAway] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const stick = useRef(true);
  const count = messages?.length ?? 0;
  const bottom = keyboard ? 8 : Math.max(insets.bottom, 12);

  // Switching chats remounts the conversation (one settle-in animation) and marks the messages that were
  // already there, so only messages that arrive afterwards animate in. Sending the first message of a new
  // chat continues the same view rather than counting as a switch.
  const [tracked, setTracked] = useState(threadId);
  const [generation, setGeneration] = useState(0);
  const [existing, setExisting] = useState(() => new Set(messages?.map((m) => m.id)));
  if (tracked !== threadId) {
    setTracked(threadId);
    if (!(tracked === null && count <= 1)) {
      setGeneration((g) => g + 1);
      setExisting(new Set(messages?.map((m) => m.id)));
    }
  }

  useEffect(() => {
    stick.current = threadId !== null;
    requestAnimationFrame(() => {
      if (threadId) scroller.current?.scrollToEnd({ animated: false });
      else scroller.current?.scrollTo({ y: 0, animated: false });
    });
  }, [threadId]);

  useEffect(() => {
    if (count > 0) {
      stick.current = true;
      scroller.current?.scrollToEnd({ animated: true });
    }
  }, [count]);

  const jumpToLatest = () => {
    stick.current = true;
    scroller.current?.scrollToEnd({ animated: true });
  };

  return (
    <SideDrawer panel={<NavPanel />}>
      <View className="flex-1 bg-background">
        <ScrollView
          ref={scroller}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
            stick.current = distance < FOLLOW_SLACK;
            const isAway = count > 0 && distance > FOLLOW_SLACK * 2;
            if (isAway !== away) setAway(isAway);
          }}
          scrollEventThrottle={32}
          onContentSizeChange={() => {
            if (stick.current && count > 0) scroller.current?.scrollToEnd({ animated: false });
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
              messages.map((m, i) => (
                <Animated.View key={m.id} entering={existing.has(m.id) ? undefined : m.role === "user" ? bubbleIn : replyIn}>
                  {m.role === "user" ? (
                    <UserMessage message={m} />
                  ) : (
                    <AssistantMessage message={m} last={i === messages.length - 1} />
                  )}
                </Animated.View>
              ))
            ) : (
              <EmptyState />
            )}
          </Animated.View>
        </ScrollView>

        <ChatHeader />

        {away ? (
          <Animated.View
            entering={popIn}
            exiting={popOut}
            style={{ position: "absolute", alignSelf: "center", bottom: composerH + bottom + 12 }}
          >
            <Tap accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={jumpToLatest}>
              <Glass radius={20} interactive>
                <View className="h-10 w-10 items-center justify-center">
                  <Icon name="arrow-down" size={18} />
                </View>
              </Glass>
            </Tap>
          </Animated.View>
        ) : null}

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          <View style={{ paddingBottom: bottom, width: "100%", maxWidth: 720, alignSelf: "center" }} pointerEvents="box-none">
            <Composer onLayout={(e) => setComposerH(e.nativeEvent.layout.height)} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </SideDrawer>
  );
}
