import type { OpenClawConfig } from "../config/config.js";
export type TelegramPairingListEntry = {
    chatId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    code: string;
    createdAt: string;
    lastSeenAt: string;
};
export declare function readTelegramAllowFromStore(env?: NodeJS.ProcessEnv): Promise<string[]>;
export declare function addTelegramAllowFromStoreEntry(params: {
    entry: string | number;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    changed: boolean;
    allowFrom: string[];
}>;
export declare function listTelegramPairingRequests(env?: NodeJS.ProcessEnv): Promise<TelegramPairingListEntry[]>;
export declare function upsertTelegramPairingRequest(params: {
    chatId: string | number;
    username?: string;
    firstName?: string;
    lastName?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    code: string;
    created: boolean;
}>;
export declare function approveTelegramPairingCode(params: {
    code: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    chatId: string;
    entry?: TelegramPairingListEntry;
} | null>;
export declare function resolveTelegramEffectiveAllowFrom(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    dm: string[];
    group: string[];
}>;
