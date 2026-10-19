import React from "react";
import { Text } from "./Text";

// 13/18, weight 600, subtext, sentence case.
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Text variant="sectionHeader" color="subtext" style={{ paddingTop: 24, paddingBottom: 6 }}>
      {children}
    </Text>
  );
}
