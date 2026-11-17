/** Cloud-neutral maintenance protocol; never expose these routes at public ingress. */
export const MAINTENANCE_PREFIX = "/_internal/maintenance";
export const PUBLIC_INGRESS_HEADER = "x-autonomo-public-ingress";
export const MAINTENANCE_PATHS = {
	ready: `${MAINTENANCE_PREFIX}/ready`,
	sweep: `${MAINTENANCE_PREFIX}/sweep`,
	drain: `${MAINTENANCE_PREFIX}/drain`,
} as const;
