import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("ingest-news", { minutes: 15 }, internal.pipeline.ingest, {});
crons.interval("publish-queue", { minutes: 10 }, internal.pipeline.publish, {});

export default crons;