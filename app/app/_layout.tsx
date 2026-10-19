import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import {
  SourceSerif4_400Regular,
  SourceSerif4_500Medium,
  useFonts,
} from "@expo-google-fonts/source-serif-4";
import { RelayProvider } from "../src/useRelay";
import { FontsLoadedProvider, useTheme } from "../src/theme";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    SourceSerif4_400Regular,
    SourceSerif4_500Medium,
  });
  return (
    <FontsLoadedProvider value={!!fontsLoaded}>
      <RootStack />
    </FontsLoadedProvider>
  );
}

function RootStack() {
  const t = useTheme();
  return (
    <RelayProvider>
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
