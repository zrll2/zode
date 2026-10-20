import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { DemoClient } from "../../src/demo/DemoClient";
import { parseChatSettings } from "../../src/chatSettings";
import { ModelSheet } from "../../src/ui/ModelSheet";
import { Pill } from "../../src/ui/Pill";
import { RenameModal } from "../../src/ui/RenameModal";
import { Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";
import { UsageSheet } from "../../src/ui/UsageSheet";

// Hidden developer preview of the chat sheets (model, usage, rename) on demo data;
// not linked from the UI.
export default function DevSheets() {
  const client = useMemo(() => new DemoClient(), []);
  const [which, setWhich] = useState<"model" | "usage" | "account" | "rename" | null>("usage");
  const [settings, setSettings] = useState<ReturnType<typeof parseChatSettings> | null>(null);

  useEffect(() => {
    client.rpc("session/resume", { sessionId: "demo-1" }).then((r) => setSettings(parseChatSettings(r)));
  }, [client]);

  const close = () => setWhich(null);
  return (
    <Screen>
      <Stack.Screen options={{ title: "Dev: chat sheets" }} />
      <Text variant="display">Chat sheets</Text>
      <View style={styles.actions}>
        <Pill label="Usage (chat)" onPress={() => setWhich("usage")} style={styles.full} />
        <Pill label="Usage (account)" variant="quiet" onPress={() => setWhich("account")} style={styles.full} />
        <Pill label="Model and thinking" variant="quiet" onPress={() => setWhich("model")} style={styles.full} />
        <Pill label="Rename" variant="quiet" onPress={() => setWhich("rename")} style={styles.full} />
      </View>
      <UsageSheet
        visible={which === "usage" || which === "account"}
        onClose={close}
        conversation={which === "usage" ? { contextUsed: 42000, contextWindow: 200000 } : null}
        fetchSessionUsage={() => client.rpc("session/usage", { sessionId: "demo-1" })}
        fetchAccountUsage={(range) => client.rpc("usage/stats", { range })}
      />
      <ModelSheet
        visible={which === "model"}
        onClose={close}
        running={false}
        models={settings?.models ?? []}
        currentModelId={settings?.model?.modelId ?? null}
        currentLevel={settings?.thoughtLevel ?? null}
        thoughtLevels={settings?.thoughtLevels ?? []}
        onPickModel={close}
        onPickLevel={close}
      />
      <RenameModal visible={which === "rename"} title="Add dark mode toggle" onClose={close} onSave={close} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 12, marginTop: 16 },
  full: { alignSelf: "stretch" },
});
