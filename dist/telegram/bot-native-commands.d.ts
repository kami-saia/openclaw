import type { Bot } from "grammy";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { ReplyToMode, TelegramAccountConfig, TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
type RegisterTelegramNativeCommandsParams = {
    bot: Bot;
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    accountId: string;
    telegramCfg: TelegramAccountConfig;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    replyToMode: ReplyToMode;
    textLimit: number;
    useAccessGroups: boolean;
    nativeEnabled: boolean;
    nativeSkillsEnabled: boolean;
    nativeDisabledExplicit: boolean;
    resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
    resolveTelegramGroupConfig: (chatId: string | number, messageThreadId?: number) => {
        groupConfig?: TelegramGroupConfig;
        topicConfig?: TelegramTopicConfig;
    };
    shouldSkipUpdate: (ctx: unknown) => boolean;
    opts: {
        token: string;
    };
};
export declare const registerTelegramNativeCommands: ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, opts, }: RegisterTelegramNativeCommandsParams) => void;
export {};
