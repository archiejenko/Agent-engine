// Agent runner service (Node). Hosted on Cloudflare Containers at cutover; runs locally with fakes.

export * from "./gates/phase2.ts";
export * from "./gates/phase3.ts";
export * from "./gates/synthetic-world.ts";
export * from "./service.ts";
