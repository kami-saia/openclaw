import type { OpenClawConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
export type LinkUnderstandingResult = {
    urls: string[];
    outputs: string[];
};
export declare function runLinkUnderstanding(params: {
    cfg: OpenClawConfig;
    ctx: MsgContext;
    message?: string;
}): Promise<LinkUnderstandingResult>;
