import React from "react";
import { Redirect } from "expo-router";
import { View } from "react-native";
import { useRelay } from "../src/useRelay";
import { useTheme } from "../src/theme";

export default function Index() {
  const { hydrated, credentials, demo } = useRelay();
  const t = useTheme();
  if (!hydrated) {
    return <View style={{ flex: 1, backgroundColor: t.colors.bg }} />;
  }
  if (demo) {
    return <Redirect href="/sessions" />;
  }
  return <Redirect href={credentials ? "/sessions" : "/pair"} />;
}
