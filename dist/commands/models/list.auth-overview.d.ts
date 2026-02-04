import { type AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderAuthOverview } from "./list.types.js";
export declare function resolveProviderAuthOverview(params: {
    provider: string;
    cfg: OpenClawConfig;
    store: AuthProfileStore;
    modelsPath: string;
}): ProviderAuthOverview;
