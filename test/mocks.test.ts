/**
 * The local mock-draft registry. Sleeper has no endpoint that lists a user's
 * mocks, so remembering them - and parsing whatever gets pasted - is on us.
 */

import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { listMockIds, parseDraftId, registerMock, unregisterMock } from "../src/data/mocks.ts";

const tmpPath = () => `${tmpdir()}/fantasy-ai-mocks-test-${crypto.randomUUID()}.json`;

describe("parseDraftId", () => {
  test("pulls the id out of a full Sleeper URL with query junk", () => {
    expect(parseDraftId("https://sleeper.com/draft/nfl/1400652160391249920?ftue=commish")).toBe(
      "1400652160391249920",
    );
  });

  test("accepts a bare id", () => {
    expect(parseDraftId("1400614733807099904")).toBe("1400614733807099904");
  });

  test("accepts an id with surrounding whitespace", () => {
    expect(parseDraftId("  1400614733807099904  ")).toBe("1400614733807099904");
  });

  test("rejects text with no plausible id", () => {
    expect(parseDraftId("my cool draft")).toBeNull();
    expect(parseDraftId("draft 123")).toBeNull();
    expect(parseDraftId("")).toBeNull();
  });
});

describe("registry", () => {
  test("an unwritten registry lists as empty rather than throwing", async () => {
    expect(await listMockIds(tmpPath())).toEqual([]);
  });

  test("registers newest-first and ignores duplicates", async () => {
    const path = tmpPath();
    await registerMock("111111111111111111", path);
    await registerMock("222222222222222222", path);
    await registerMock("111111111111111111", path);
    expect(await listMockIds(path)).toEqual(["222222222222222222", "111111111111111111"]);
  });

  test("unregister removes exactly one id", async () => {
    const path = tmpPath();
    await registerMock("111111111111111111", path);
    await registerMock("222222222222222222", path);
    await unregisterMock("111111111111111111", path);
    expect(await listMockIds(path)).toEqual(["222222222222222222"]);
  });

  test("a corrupt registry file degrades to empty", async () => {
    const path = tmpPath();
    await Bun.write(path, "{not json");
    expect(await listMockIds(path)).toEqual([]);
  });
});
