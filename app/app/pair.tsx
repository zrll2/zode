import React, { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Linking from "expo-linking";
import { useRelay } from "../src/useRelay";
import { parsePairingPayload, pair } from "../src/pairing";
import { PRIVACY_URL } from "../src/config";
import { radius, useTheme } from "../src/theme";
import { Pill } from "../src/ui/Pill";
import { Screen } from "../src/ui/Screen";
import { Text } from "../src/ui/Text";
import { friendlyError } from "../src/friendlyError";

function deviceName(): string {
  const anyConstants = Constants as any;
  if (typeof anyConstants?.deviceName === "string" && anyConstants.deviceName) {
    return anyConstants.deviceName;
  }
  return Platform.OS === "ios" ? "iPhone" : "Android phone";
}

export default function PairScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connect, startDemo } = useRelay();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);

  async function pairWith(raw: string) {
    if (busy || !raw.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload = parsePairingPayload(raw);
      const result = await pair(payload, deviceName());
      connect({
        wsUrl: result.wsUrl,
        wsUrls: result.wsUrls,
        token: result.token,
        deviceId: result.id,
      });
      router.replace("/sessions");
    } catch (e: any) {
      setError(friendlyError(e, "pair"));
      setScanned(false);
    } finally {
      setBusy(false);
    }
  }

  async function startScan() {
    if (permission?.granted) {
      setScanning(true);
      return;
    }
    const result = await requestPermission();
    if (result.granted) setScanning(true);
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.flex, { paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.center}>
          <Image source={require("../assets/zode-mark.png")} style={styles.mark} accessibilityLabel="Zode" />
          <Text variant="display">Connect to your Mac</Text>
          <Text variant="body" color="subtext" style={styles.paragraph}>
            Scan the code on your Mac.
          </Text>
        </View>
        <View style={styles.actions}>
          {scanning ? (
            <View style={[styles.camera, { borderColor: t.colors.border }]}>
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={
                  busy || scanned
                    ? undefined
                    : (event) => {
                        setScanned(true);
                        void pairWith(event.data);
                      }
                }
              />
            </View>
          ) : (
            <Pill
              label="Scan QR code"
              onPress={() => void startScan()}
              style={styles.fullWidth}
            />
          )}
          <Pressable
            onPress={() => setShowPaste(!showPaste)}
            accessibilityRole="button"
            accessibilityLabel="Paste pairing text"
            hitSlop={8}
            style={styles.pasteToggle}
          >
            <Text variant="button" color="accent">
              {showPaste ? "Hide pairing text" : "Paste pairing text"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              startDemo();
              router.replace("/sessions");
            }}
            accessibilityRole="button"
            accessibilityLabel="Try the demo"
            hitSlop={8}
            style={styles.pasteToggle}
          >
            <Text variant="button" color="subtext">
              Try the demo
            </Text>
          </Pressable>
          {showPaste ? (
            <View style={styles.pasteBox}>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: t.colors.surface,
                    borderColor: t.colors.border,
                    color: t.colors.text,
                  },
                ]}
                multiline
                placeholder={'{"u":"ws://…","w":"…","c":"…"}'}
                placeholderTextColor={t.colors.subtext}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                textContentType="none"
                keyboardType="ascii-capable"
                importantForAutofill="no"
                value={text}
                onChangeText={setText}
              />
              <Pill
                label={busy ? "Connecting…" : "Connect"}
                disabled={busy || !text.trim()}
                onPress={() => void pairWith(text)}
                style={styles.fullWidth}
              />
            </View>
          ) : undefined}
          {error ? (
            <Text variant="bodySmall" color="danger" style={styles.error}>
              {error}
            </Text>
          ) : undefined}
          <Pressable
            onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => {})}
            accessibilityRole="link"
            accessibilityLabel="Privacy policy"
            hitSlop={8}
            style={styles.privacyLink}
          >
            <Text variant="caption" color="subtext">
              Privacy policy
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  mark: { width: 72, height: 72, marginBottom: 12 },
  paragraph: { textAlign: "center", marginTop: 8, maxWidth: 320 },
  actions: { gap: 12 },
  camera: {
    height: 300,
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  fullWidth: { alignSelf: "stretch" },
  pasteToggle: { alignSelf: "center", padding: 8 },
  pasteBox: { gap: 12 },
  input: {
    minHeight: 96,
    borderRadius: radius.code,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    fontSize: 14,
    textAlignVertical: "top",
  },
  error: { textAlign: "center" },
  privacyLink: { alignSelf: "center", marginTop: 8, padding: 8 },
});
