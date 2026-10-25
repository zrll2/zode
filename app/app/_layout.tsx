import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import {
  Nunito_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/nunito";
import {
  SourceSerif4_400Regular,
  SourceSerif4_500Medium,
} from "@expo-google-fonts/source-serif-4";
import { RelayProvider } from "../src/useRelay";
import { useWatchBridge } from "../src/watchBridge";
import { FontsLoadedProvider, useTheme } from "../src/theme";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    SourceSerif4_400Regular,
    SourceSerif4_500Medium,
    Nunito_800ExtraBold,
  });
  return (
    <FontsLoadedProvider value={!!fontsLoaded}>
      <RootStack />
    </FontsLoadedProvider>
  );
}

// Mounted once near the root so the watch can reach the relay state from
// anywhere (W1 spike).
function WatchBridge() {
  useWatchBridge();
  return null;
}

function RootStack() {
  const t = useTheme();
  return (
    <RelayProvider>
      <WatchBridge />
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.colors.bg },
          headerShadowVisible: false,
          headerTintColor: t.colors.text,
          headerTitleStyle: { color: t.colors.text, fontSize: 16, fontWeight: "600" },
          // arrow only, never the previous page name
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          contentStyle: { backgroundColor: t.colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
        <Stack.Screen name="sessions" options={{ headerShown: false }} />
        <Stack.Screen name="new" options={{ headerTitle: "" }} />
        <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
      </Stack>
    </RelayProvider>
  );
}
