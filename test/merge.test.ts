import { describe, expect, it } from "vitest";

import { merge3 } from "../shared/merge";

const file = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");

describe("merge3", () => {
  const base = file("a", "b", "c", "d", "e", "f");

  it("takes the side that changed", () => {
    expect(merge3(base, base, file("a", "B", "c", "d", "e", "f"))).toBe(file("a", "B", "c", "d", "e", "f"));
    expect(merge3(base, file("a", "B", "c", "d", "e", "f"), base)).toBe(file("a", "B", "c", "d", "e", "f"));
  });

  it("merges changes in different places", () => {
    expect(merge3(base, file("A", "b", "c", "d", "e", "f"), file("a", "b", "c", "d", "e", "F"))).toBe(file("A", "b", "c", "d", "e", "F"));
  });

  it("merges additions and removals", () => {
    expect(merge3(base, file("a", "new", "b", "c", "d", "e", "f"), file("a", "b", "c", "d", "f"))).toBe(file("a", "new", "b", "c", "d", "f"));
  });

  it("accepts the same change on both sides", () => {
    expect(merge3(base, file("a", "B", "c", "d", "e", "f"), file("a", "B", "c", "d", "E", "f"))).toBe(file("a", "B", "c", "d", "E", "f"));
    expect(merge3(base, file("a", "B", "c", "d", "e", "f"), file("a", "B", "c", "d", "e", "f"))).toBe(file("a", "B", "c", "d", "e", "f"));
  });

  it("gives up when both changed the same lines differently", () => {
    expect(merge3(base, file("a", "mine", "c", "d", "e", "f"), file("a", "theirs", "c", "d", "e", "f"))).toBeNull();
    // Adding at the same spot clashes too.
    expect(merge3(base, file("a", "b", "mine", "c", "d", "e", "f"), file("a", "b", "theirs", "c", "d", "e", "f"))).toBeNull();
  });

  it("handles a file with no newline at the end", () => {
    expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
  });

  it("handles a file one side emptied or the other created", () => {
    expect(merge3("", "", "new\n")).toBe("new\n");
    expect(merge3("a\n", "", "a\n")).toBe("");
  });
});
