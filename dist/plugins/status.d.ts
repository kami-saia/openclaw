import { loadConfig } from "../config/config.js";
import type { PluginRegistry } from "./registry.js";
export type PluginStatusReport = PluginRegistry & {
    workspaceDir?: string;
};
export declare function buildPluginStatusReport(params?: {
    config?: ReturnType<typeof loadConfig>;
    workspaceDir?: string;
}): PluginStatusReport;
