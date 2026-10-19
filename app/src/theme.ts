import { createContext, createElement, useContext, type ReactNode } from "react";
import { Platform, useColorScheme } from "react-native";

// Tokens from docs/DESIGN.md §2. No other file may hard-code a color.
export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { pill: 999, composer: 26, bubble: 20, code: 12 } as const;

const serifFallback = Platform.select({ ios: "Georgia", android: "serif" }) ?? "serif";
const monoFallback = Platform.select({ ios: "Menlo", android: "monospace" }) ?? "monospace";

export interface ThemeFonts {
  serif: string; // display / screen titles, weight 500
  serifRegular: string; // weight 400
  mono: string;
}

export const lightColors = {
  bg: "#FAF9F5",
  surface: "#FFFFFF",
  muted: "#F0EEE6",
  border: "#E8E5DA",
  text: "#141413",
  subtext: "#6F6D66",
  accent: "#141413",
  onAccent: "#FAF9F5",
  scrim: "rgba(20,20,19,0.45)",
  danger: "#B3261E",
  ok: "#4C8B5F",
  warn: "#B7791F",
};

export const darkColors = {
  bg: "#1F1E1D",
  surface: "#2B2A28",
  muted: "#34332F",
  border: "#3A3935",
  text: "#F5F4ED",
  subtext: "#A8A59B",
  accent: "#F5F4ED",
  onAccent: "#1F1E1D",
  scrim: "rgba(0,0,0,0.55)",
  danger: "#F2958D",
  ok: "#7FC495",
  warn: "#E3B341",
};

const FontsLoadedContext = createContext(false);

export function FontsLoadedProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return createElement(FontsLoadedContext.Provider, { value }, children);
}

export function useTheme() {
  const fontsLoaded = useContext(FontsLoadedContext);
  const dark = useColorScheme() === "dark";
  // System serif until Source Serif 4 has loaded; never block the app on it.
  const fonts: ThemeFonts = fontsLoaded
    ? { serif: "SourceSerif4_500Medium", serifRegular: "SourceSerif4_400Regular", mono: monoFallback }
    : { serif: serifFallback, serifRegular: serifFallback, mono: monoFallback };
  return {
    dark,
    fonts,
    colors: dark ? darkColors : lightColors,
  };
}

export type ThemeColors = ReturnType<typeof useTheme>["colors"];
export type ThemeColorName = keyof ThemeColors;

// WCAG 2.x contrast ratio between two #rrggbb colors (token audit tests).
export function contrastRatio(hexA: string, hexB: string): number {
  function luminance(hex: string): number {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((offset) => {
      const raw = parseInt(value.slice(offset, offset + 2), 16) / 255;
      return raw <= 0.03928 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
