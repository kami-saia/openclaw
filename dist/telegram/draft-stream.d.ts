import type { Bot } from "grammy";
export type TelegramDraftStream = {
    update: (text: string) => void;
    flush: () => Promise<void>;
    stop: () => void;
};
export declare function createTelegramDraftStream(params: {
    api: Bot["api"];
    chatId: number;
    draftId: number;
    maxChars?: number;
    messageThreadId?: number;
    throttleMs?: number;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}): TelegramDraftStream;
