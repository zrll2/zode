export interface MenuItem {
  key: string;
  label: string;
  destructive?: boolean;
}

// Items for the Sessions overflow sheet. Pure: the screen maps keys to
// actions (DESIGN/order 13 — About entries first, destructive action last
// before Cancel).
export function buildMenuItems({ demo }: { demo: boolean }): MenuItem[] {
  return [
    { key: "privacy", label: "Privacy policy" },
    { key: "support", label: "Support" },
    demo
      ? { key: "exit-demo", label: "Exit demo", destructive: true }
      : { key: "unpair", label: "Unpair this phone", destructive: true },
    { key: "cancel", label: "Cancel" },
  ];
}
