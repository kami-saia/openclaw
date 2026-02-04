import type { OpenClawConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
export type ApplyLinkUnderstandingResult = {
    outputs: string[];
    urls: string[];
};
export declare function applyLinkUnderstanding(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
}): Promise<ApplyLinkUnderstandingResult>;
