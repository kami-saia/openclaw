import { type SavedMedia } from "../media/store.js";
export type TelegramFileInfo = {
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
};
export declare function getTelegramFile(token: string, fileId: string): Promise<TelegramFileInfo>;
export declare function downloadTelegramFile(token: string, info: TelegramFileInfo, maxBytes?: number): Promise<SavedMedia>;
