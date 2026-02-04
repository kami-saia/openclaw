import type { ChannelDirectoryEntry } from "../channels/plugins/types.js";
import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";
export declare function listDiscordDirectoryGroupsLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
export declare function listDiscordDirectoryPeersLive(params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]>;
