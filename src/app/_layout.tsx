import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useFonts } from "expo-font";
import { DarkTheme, Stack, ThemeProvider, type Theme } from "expo-router";
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
import { KeyboardProvider } from "react-native-keyboard-controller";
import { PortalHost } from "@/components/ui/Portal";

/**
 * React Navigation paints the stack's container in its theme's background, which shows at the
 * screen edges while a screen slides in or out. The default theme is light (rgb 242), so a pale
 * rim flashed around every transition; the app's own black matches the screens.
 */
const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
  },
};

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
        <KeyboardProvider>
          <HeroUINativeProvider
            config={{ devInfo: { stylingPrinciples: false }, toast: "disabled" }}
          >
            <ThemeProvider value={navTheme}>
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
            </ThemeProvider>
            <PortalHost />
            <ToastHost />
            <StatusBar style="light" />
          </HeroUINativeProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </ConvexAuthProvider>
  );
}
