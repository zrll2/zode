import React, { useEffect, useRef } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { HomeItem } from "../homeList";
import { useTheme } from "../theme";
import { Dot } from "./Dot";
import { Text } from "./Text";

const ACTION_WIDTH = 88;
const OPEN_DISTANCE = -ACTION_WIDTH;
const ARCHIVE_THRESHOLD = -44;

interface HomeRowProps {
  item: HomeItem;
  running?: boolean; // pulsing accent dot instead of the finished tick
  last?: boolean; // no hairline below the final row in the group
  onOpen: () => void;
  // History rows only: swipe left past halfway (or the revealed action)
  // archives the conversation.
  onArchive?: () => void;
}

// One dense row of a grouped history surface (home-list-v2: .row): leading
// status mark, conversation title over the project, time on the right.
// History rows swipe left to Archive with PanResponder + Animated; only
// clearly horizontal moves are claimed so the list still scrolls vertically.
export function HomeRow({ item, running = false, last = false, onOpen, onArchive }: HomeRowProps) {
  const t = useTheme();
  const translate = useRef(new Animated.Value(0)).current;
  const baseRef = useRef(0);

  const animateTo = (value: number) => {
    // JS driver: PanResponder drives this value with setValue every move.
    Animated.timing(translate, {
      toValue: value,
      duration: 180,
      useNativeDriver: false,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderGrant: () => {
        baseRef.current = 0; // rows only drag from closed; archive removes the row
      },
      onPanResponderMove: (_event, gesture) => {
        const next = Math.min(0, Math.max(OPEN_DISTANCE - 8, baseRef.current + gesture.dx));
        translate.setValue(next);
      },
      onPanResponderRelease: (_event, gesture) => {
        const next = baseRef.current + gesture.dx;
        if (next < ARCHIVE_THRESHOLD) {
          onArchive?.();
          return;
        }
        animateTo(0);
      },
      onPanResponderTerminate: () => animateTo(0),
    }),
  ).current;

  useEffect(() => {
    translate.setValue(0);
  }, [item.id, translate]);

  const stateWord = running ? `working ${item.time}` : `finished ${item.time}`;

  return (
    <View
      style={[
        styles.swipe,
        last
          ? undefined
          : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border },
      ]}
    >
      {onArchive ? (
        <Pressable
          style={[styles.under, { backgroundColor: t.colors.danger }]}
          onPress={onArchive}
          accessibilityRole="button"
          accessibilityLabel={`Archive ${item.title}`}
        >
          <Text style={[styles.underText, { color: t.colors.onAccent }]}>Archive</Text>
        </Pressable>
      ) : undefined}
      <Animated.View style={{ transform: [{ translateX: translate }] }} {...(onArchive ? panResponder.panHandlers : {})}>
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`${item.title}, ${item.project}, ${stateWord}`}
          accessibilityActions={
            onArchive ? [{ name: "archive", label: "Archive" }] : undefined
          }
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "archive") onArchive?.();
          }}
          style={[styles.row, { backgroundColor: t.colors.surface }]}
        >
          <View style={styles.mark}>
            {running ? (
              <Dot color={t.colors.accent} size={9} pulse />
            ) : (
              <Feather name="check" size={15} color={t.colors.ok} />
            )}
          </View>
          <View style={styles.body}>
            <Text numberOfLines={1} style={[styles.title, { color: t.colors.text }]}>
              {item.title}
            </Text>
            <Text numberOfLines={1} style={[styles.sub, { color: t.colors.subtext }]}>
              {item.project}
            </Text>
          </View>
          <Text style={[styles.time, { color: t.colors.subtext }]}>{item.time}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  swipe: { overflow: "hidden" },
  under: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: ACTION_WIDTH,
    alignItems: "center",
    justifyContent: "center",
  },
  underText: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 56,
  },
  mark: { width: 20, alignItems: "center" },
  body: { flex: 1 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  sub: { fontSize: 12.5, lineHeight: 17 },
  time: { fontSize: 12.5, lineHeight: 17, fontVariant: ["tabular-nums"] },
});
