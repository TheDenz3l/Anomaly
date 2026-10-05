import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("reap stale replies", { minutes: 15 }, internal.engine.data.reapStale, {});
crons.daily("clean web cache", { hourUTC: 4, minuteUTC: 0 }, internal.webCache.cleanup, {});
crons.monthly(
  "reset probe spend",
  { day: 1, hourUTC: 0, minuteUTC: 0 },
  internal.settings.resetProbeSpendAll,
  {}
);

export default crons;
