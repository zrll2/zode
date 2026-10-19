import React from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";

interface ScreenProps {
  children: React.ReactNode;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}

// Screen background + safe-area top; pass padded={false} when children
// manage their own side padding.
export function Screen({ children, padded = true, style }: ScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        { flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top },
        padded ? { paddingHorizontal: 20 } : undefined,
        style,
      ]}
    >
      {children}
    </View>
  );
}
