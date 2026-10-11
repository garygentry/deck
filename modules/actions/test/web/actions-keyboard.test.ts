import { describe, expect, it } from "vitest";

import {
  resolveActionIntent,
  shouldPreventActionDefault,
  type ActionKeyEvent,
  type ActionKeyIntent,
} from "../../web/keyboard.js";

function key(
  k: string,
  modifiers: { ctrl?: boolean; meta?: boolean } = {},
): ActionKeyEvent {
  return { key: k, ctrlKey: modifiers.ctrl ?? false, metaKey: modifiers.meta ?? false };
}

// ---------------------------------------------------------------------------
// resolveActionIntent
// ---------------------------------------------------------------------------

describe("resolveActionIntent", () => {
  it("maps Escape to 'cancel'", () => {
    expect(resolveActionIntent(key("Escape"))).toBe("cancel");
  });

  it("maps Enter to 'submit'", () => {
    expect(resolveActionIntent(key("Enter"))).toBe("submit");
  });

  it("maps any other key to 'none'", () => {
    for (const k of ["a", "Tab", " ", "ArrowDown", "F1", "Backspace", "1"]) {
      expect(resolveActionIntent(key(k))).toBe("none");
    }
  });

  it("returns 'none' for any Ctrl or Meta chord, even on Escape/Enter", () => {
    expect(resolveActionIntent(key("Escape", { ctrl: true }))).toBe("none");
    expect(resolveActionIntent(key("Enter", { ctrl: true }))).toBe("none");
    expect(resolveActionIntent(key("Escape", { meta: true }))).toBe("none");
    expect(resolveActionIntent(key("Enter", { meta: true }))).toBe("none");
    expect(resolveActionIntent(key("k", { ctrl: true }))).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// shouldPreventActionDefault
// ---------------------------------------------------------------------------

describe("shouldPreventActionDefault", () => {
  it("is false for 'none' and true for handled intents", () => {
    expect(shouldPreventActionDefault("none")).toBe(false);
    expect(shouldPreventActionDefault("cancel")).toBe(true);
    expect(shouldPreventActionDefault("submit")).toBe(true);
  });

  it("prevents default exactly for the intents the resolver handles", () => {
    const intents: ActionKeyIntent[] = ["cancel", "submit", "none"];
    for (const intent of intents) {
      expect(shouldPreventActionDefault(intent)).toBe(intent !== "none");
    }
  });
});
