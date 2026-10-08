// @vitest-environment edge-runtime
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { signedIn } from "./convex";

it("runs Convex functions against the real schema", async () => {
  const { as } = await signedIn();
  expect(await as.query(api.threads.list, {})).toEqual([]);
});
