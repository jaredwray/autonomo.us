import type { VideoKind } from "@autonomo.us/common";
import type { VideoAdapter } from "../types.js";
import { googleAdapter } from "./google.js";
import { lumaAdapter } from "./luma.js";
import { runwayAdapter } from "./runway.js";

/** The adapter behind each video kind. */
export const VIDEO_ADAPTERS: Record<VideoKind, VideoAdapter> = {
	google: googleAdapter,
	runway: runwayAdapter,
	luma: lumaAdapter,
};

export { googleAdapter, lumaAdapter, runwayAdapter };
