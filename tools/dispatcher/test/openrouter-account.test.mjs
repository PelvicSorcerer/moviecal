import { describe, it, expect } from "vitest";
import { parseOpenRouterAccount } from "../src/openrouter-account.mjs";

describe("OpenRouter account metadata", () => {
  const key = { data: { limit: 69, usage: 1.25, limit_remaining: 67.75 } };
  const credits = { data: { total_credits: 80, total_usage: 12 } };
  it("returns only verified numeric usage and credit evidence", () => {
    expect(parseOpenRouterAccount(key, credits)).toEqual({ keyUsageUsd: 1.25, keyRemainingUsd: 67.75, availableCreditUsd: 68 });
  });
  it.each([
    [{ data: { ...key.data, limit: 75 } }, credits],
    [{ data: { ...key.data, usage: null } }, credits],
    [key, { data: { ...credits.data, total_usage: 81 } }],
    [{ data: { ...key.data, limit_remaining: 70 } }, credits],
  ])("refuses unknown, changed or exhausted account evidence", (k, c) => {
    expect(() => parseOpenRouterAccount(k, c)).toThrow(/allowance/);
  });
});
