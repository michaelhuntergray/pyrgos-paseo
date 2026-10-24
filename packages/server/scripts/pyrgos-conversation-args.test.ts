import { describe, expect, test } from "vitest";

import { parseConversationArgs } from "./pyrgos-conversation-args.js";

describe("parseConversationArgs", () => {
  test("keeps the first turn when --model is omitted", () => {
    expect(parseConversationArgs(["create an item", "yes"])).toEqual({
      model: undefined,
      turns: ["create an item", "yes"],
    });
  });

  test("removes --model and its value wherever it appears", () => {
    expect(parseConversationArgs(["a", "--model", "haiku", "b"])).toEqual({
      model: "haiku",
      turns: ["a", "b"],
    });
  });
});
