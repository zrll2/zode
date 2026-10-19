import React, { useState } from "react";
import { View, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { ApprovalSheet } from "../../src/ui/ApprovalSheet";
import { Pill } from "../../src/ui/Pill";
import { Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

// Hidden developer preview of the approval sheet (DESIGN.md §3.5);
// not linked from the UI.
export default function DevApproval() {
  const [visible, setVisible] = useState(true);
  const [answeredElsewhere, setAnsweredElsewhere] = useState(false);

  function show(answered: boolean) {
    setAnsweredElsewhere(answered);
    setVisible(true);
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "Dev: approval sheet" }} />
      <Text variant="display">Approval sheet</Text>
      <View style={styles.actions}>
        <Pill label="Show sheet" onPress={() => show(false)} style={styles.fullWidth} />
        <Pill
          label="Show answered elsewhere"
          variant="quiet"
          onPress={() => show(true)}
          style={styles.fullWidth}
        />
      </View>
      <ApprovalSheet
        visible={visible}
        title="Allow this edit?"
        folder="shop-api"
        toolName="Edit"
        target="/Users/demo/projects/shop-api/src/router.ts"
        reason="Needed to fix the login redirect."
        onAllow={() => setVisible(false)}
        onDeny={() => setVisible(false)}
        answeredElsewhere={answeredElsewhere}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 12, marginTop: 16 },
  fullWidth: { alignSelf: "stretch" },
});
