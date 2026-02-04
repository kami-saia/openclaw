export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";
export type GatewayServer = {
    close: (opts?: {
        reason?: string;
        restartExpectedMs?: number | null;
    }) => Promise<void>;
};
export type GatewayServerOptions = {
    bind?: import("../config/config.js").GatewayBindMode;
    host?: string;
    controlUiEnabled?: boolean;
    openAiChatCompletionsEnabled?: boolean;
    openResponsesEnabled?: boolean;
    auth?: import("../config/config.js").GatewayAuthConfig;
    tailscale?: import("../config/config.js").GatewayTailscaleConfig;
    allowCanvasHostInTests?: boolean;
    wizardRunner?: (opts: import("../commands/onboard-types.js").OnboardOptions, runtime: import("../runtime.js").RuntimeEnv, prompter: import("../wizard/prompts.js").WizardPrompter) => Promise<void>;
};
export declare function startGatewayServer(port?: number, opts?: GatewayServerOptions): Promise<GatewayServer>;
