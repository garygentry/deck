import { describe, expect, it } from "vitest";

// ui-deep-import: highlight.js is not in the barrel, so it stays out of the main bundle.
import { languageForName } from "@/ui/lib/highlight.js";

import { LANGUAGE_HINT_BY_EXT, LANGUAGE_HINT_BY_NAME, languageForPath } from "../../server/language.js";

describe("the server's language hint agrees with the kernel highlighter", () => {
  it("names, for every hinted name and extension, the language the highlighter picks", () => {
    const paths = [
      ...Object.keys(LANGUAGE_HINT_BY_NAME).map((name) => `dir/${name}`),
      ...Object.keys(LANGUAGE_HINT_BY_EXT).map((ext) => `dir/file.${ext}`),
    ];
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) expect(languageForName(path), path).toBe(languageForPath(path));
  });

  it("hints nothing for a name neither knows, and matches basenames whatever their case", () => {
    expect(languageForPath("weird.zzz")).toBeUndefined();
    expect(languageForName("weird.zzz")).toBeUndefined();
    expect(languageForPath("a/b/DOCKERFILE")).toBe("dockerfile");
    expect(languageForPath(".env")).toBeUndefined();
  });
});
