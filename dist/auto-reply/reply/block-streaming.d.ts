import type { OpenClawConfig } from "../../config/config.js";
export type BlockStreamingCoalescing = {
    minChars: number;
    maxChars: number;
    idleMs: number;
    joiner: string;
};
export declare function resolveBlockStreamingChunking(cfg: OpenClawConfig | undefined, provider?: string, accountId?: string | null): {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
};
export declare function resolveBlockStreamingCoalescing(cfg: OpenClawConfig | undefined, provider?: string, accountId?: string | null, chunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
}): BlockStreamingCoalescing | undefined;
