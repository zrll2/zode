import { Redirect, Stack } from "expo-router";
import React from "react";

// Dev-only screens: unreachable in release builds. Demo mode (pair screen)
// is separate and stays available for App Review.
export default function DevLayout() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <Stack />;
}
