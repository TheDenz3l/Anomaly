/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import schema from "../convex/schema";

/** Every Convex module, for convex-test (it finds the project root from the _generated folder). */
export const modules = import.meta.glob("../convex/**/*.*s");

/** A fresh in-memory deployment running the real functions against the real schema. */
export const newTest = () => convexTest(schema, modules);

/** A test deployment plus a signed-in user, the way Convex Auth identifies one. */
export async function signedIn() {
  const t = newTest();
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  return { t, userId, as: t.withIdentity({ subject: `${userId}|test-session` }) };
}
