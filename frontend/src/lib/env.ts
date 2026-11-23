import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import type { Identity } from "@icp-sdk/core/agent";
import { createActor } from "../bindings/ashkey/ashkey";

interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:ashkey": string;
  readonly "PUBLIC_CANISTER_ID:frontend": string;
}

const env = getCanisterEnv<CanisterEnv>();

export const backendId = env["PUBLIC_CANISTER_ID:ashkey"];
export const frontendId = env["PUBLIC_CANISTER_ID:frontend"];
export const rootKey = env.IC_ROOT_KEY;
export const isLocal = location.hostname.endsWith("localhost") || location.hostname === "127.0.0.1";

export function getActor(identity?: Identity) {
  return createActor(backendId, { agentOptions: { rootKey, identity } });
}
export type Api = ReturnType<typeof getActor>;

export { ok } from "./result";
