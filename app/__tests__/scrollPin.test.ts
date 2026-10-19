import { computePinState } from "../src/scrollPin";

const VIEWPORT = 1000;

function at(offsetY: number, contentHeight: number) {
  return computePinState({ offsetY, contentHeight, viewportHeight: VIEWPORT });
}

describe("computePinState", () => {
  it("stays pinned at exactly 40 px and releases at 41 px", () => {
    expect(at(0, 1040)).toEqual({ distanceFromBottom: 40, pinned: true, showJump: false });
    expect(at(0, 1041)).toEqual({ distanceFromBottom: 41, pinned: false, showJump: false });
  });

  it("shows the jump pill only beyond 120 px", () => {
    expect(at(0, 1120)).toEqual({ distanceFromBottom: 120, pinned: false, showJump: false });
    expect(at(0, 1121)).toEqual({ distanceFromBottom: 121, pinned: false, showJump: true });
  });

  it("treats empty content as pinned", () => {
    expect(computePinState({ offsetY: 0, contentHeight: 0, viewportHeight: 800 })).toEqual({
      distanceFromBottom: -800,
      pinned: true,
      showJump: false,
    });
  });

  it("pins when the content is shorter than the viewport", () => {
    const state = computePinState({ offsetY: 0, contentHeight: 300, viewportHeight: 800 });
    expect(state).toEqual({ distanceFromBottom: -500, pinned: true, showJump: false });
  });

  it("pins again at the very bottom", () => {
    const state = at(1000, 2000);
    expect(state).toEqual({ distanceFromBottom: 0, pinned: true, showJump: false });
  });
});
