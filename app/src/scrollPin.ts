import { useCallback, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

const PIN_THRESHOLD = 40;
const JUMP_THRESHOLD = 120;
const TOUCH_GRACE_MS = 150;

// Pure bottom-distance math for the chat list (ported from the reference's
// scroll pinning: pinned within 40 px, "jump to latest" beyond 120 px).
export function computePinState(args: {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}): { distanceFromBottom: number; pinned: boolean; showJump: boolean } {
  const distanceFromBottom = args.contentHeight - (args.offsetY + args.viewportHeight);
  return {
    distanceFromBottom,
    pinned: distanceFromBottom <= PIN_THRESHOLD,
    showJump: distanceFromBottom > JUMP_THRESHOLD,
  };
}

interface Scrollable {
  scrollToEnd(options?: { animated?: boolean }): void;
}

// Scroll pinning that does not fight the thumb: streaming content re-pins to
// the bottom only while still pinned and more than 150 ms after the last
// user drag; programmatic scrolls never release the pin.
export function useScrollPin(listRef: { current: Scrollable | null }) {
  const pinnedRef = useRef(true);
  const lastTouchRef = useRef(0);
  const programmaticRef = useRef(false);
  const programmaticTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showJump, setShowJump] = useState(false);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
    programmaticTimer.current = setTimeout(() => {
      programmaticRef.current = false;
    }, 400);
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (programmaticRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const state = computePinState({
      offsetY: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    });
    pinnedRef.current = state.pinned;
    setShowJump(state.showJump);
  }, []);

  const onScrollBeginDrag = useCallback(() => {
    pinnedRef.current = false;
    lastTouchRef.current = Date.now();
  }, []);

  const onMomentumScrollEnd = useCallback(() => {
    lastTouchRef.current = Date.now();
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (pinnedRef.current && Date.now() - lastTouchRef.current > TOUCH_GRACE_MS) {
      markProgrammatic();
      listRef.current?.scrollToEnd({ animated: false });
    }
  }, [listRef, markProgrammatic]);

  const jumpToEnd = useCallback(() => {
    pinnedRef.current = true;
    setShowJump(false);
    markProgrammatic();
    listRef.current?.scrollToEnd({ animated: true });
  }, [listRef, markProgrammatic]);

  return {
    onScroll,
    onScrollBeginDrag,
    onMomentumScrollEnd,
    onContentSizeChange,
    jumpToEnd,
    showJump,
  };
}
