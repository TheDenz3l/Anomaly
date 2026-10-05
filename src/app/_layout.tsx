import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import * as SecureStore from "expo-secure-store";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Uniwind } from "uniwind";
import { ToastHost } from "@/components/ui/ToastHost";
import { convex } from "@/lib/convex";
import { ConvexSync } from "@/lib/sync";
import { colors } from "@/lib/theme";

import "../global.css";

Uniwind.setTheme("dark");
void SplashScreen.preventAutoHideAsync();

/** Session tokens live in the iOS Keychain / Android Keystore; web falls back to localStorage. */
const secureStorage =
  Platform.OS === "web"
    ? undefined
    : {
        getItem: SecureStore.getItemAsync,
        setItem: SecureStore.setItemAsync,
        removeItem: SecureStore.deleteItemAsync,
      };

export default function RootLayout() {
  const [loaded, error] = useFonts({
    "Satoshi-Regular": require("../../assets/fonts/Satoshi-Regular.otf"),
    "Satoshi-Medium": require("../../assets/fonts/Satoshi-Medium.otf"),
    "Satoshi-Bold": require("../../assets/fonts/Satoshi-Bold.otf"),
    "Satoshi-Italic": require("../../assets/fonts/Satoshi-Italic.otf"),
    Moderniz: require("../../assets/fonts/Moderniz.otf"),
  });

  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [loaded, error]);

  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  return (
    <ConvexAuthProvider client={convex} storage={secureStorage}>
      <ConvexSync />
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
        <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false }, toast: "disabled" }}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="history" />
            <Stack.Screen name="memory" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="artifacts" />
            <Stack.Screen name="artifact/[id]" />
          </Stack>
          <ToastHost />
          <StatusBar style="light" />
        </HeroUINativeProvider>
      </GestureHandlerRootView>
    </ConvexAuthProvider>
  );
}
