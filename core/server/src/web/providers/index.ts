import type { ProxyKind } from "@autonomo.us/common";
import type { ProxyAdapter } from "../types.js";
import { brightdataAdapter } from "./brightdata.js";
import { cloudflareAdapter } from "./cloudflare.js";
import { zenrowsAdapter } from "./zenrows.js";

/** The adapter behind each proxy kind. */
export const PROXY_ADAPTERS: Record<ProxyKind, ProxyAdapter> = {
	zenrows: zenrowsAdapter,
	"cloudflare-browser": cloudflareAdapter,
	brightdata: brightdataAdapter,
};

export { brightdataAdapter, cloudflareAdapter, zenrowsAdapter };
