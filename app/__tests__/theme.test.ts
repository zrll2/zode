import { contrastRatio, darkColors, lightColors } from "../src/theme";

// DESIGN.md §2: body text needs at least 4.5:1 in both themes.
describe("theme token contrast", () => {
  const themes = [
    ["light", lightColors],
    ["dark", darkColors],
  ] as const;

  it.each(themes)("%s: text on bg is readable", (_name, colors) => {
    expect(contrastRatio(colors.text, colors.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("%s: onAccent on accent is readable", (_name, colors) => {
    expect(contrastRatio(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
