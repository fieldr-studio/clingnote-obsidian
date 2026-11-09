import type { ConnectionStatus } from "./types";
import { SUPPORTED_PROTOCOL_MAJOR } from "./types";
// Release configuration: the official companion download page (HTTPS only; validated by downloadUrl()).
export const COMPANION_DOWNLOAD_URL = "https://clingnote.com/obsidian";
export function downloadUrl(value: string): string | null {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export type ConnectionIssue = "incompatible" | "missing" | "installed" | "interrupted" | null;
export interface ConnectionNotice { text: string; action: "download" | "retry" | "license" | null }

const WHAT = "ClingNote uses a small Windows companion that runs on your PC (nothing leaves it) to see which app, folder or web page you are in.";
const INCOMPATIBLE = `This companion is not compatible with this version of the plugin (the plugin supports companion protocol ${SUPPORTED_PROTOCOL_MAJOR}). Install the latest official companion.`;

/** Full explanation for the settings page. Only states backed by evidence are distinguished. */
export function connectionGuidance(status: ConnectionStatus, issue: string | null): string {
    if (status === "connected") return "Connected. The companion is ready; context safety checks still apply.";
    if (status === "connecting") return "Connecting to the Windows companion…";
    if (issue === "missing") return `${WHAT} It does not appear to be installed. Download and run the official Windows setup, then choose Retry. No administrator rights are needed.`;
    if (issue === "installed") return "The companion is installed but not running. Open “ClingNote for Obsidian” from the Windows Start menu, then choose Retry.";
    if (issue === "interrupted") return "The connection to the companion was interrupted. It may have been closed or restarted. Open “ClingNote for Obsidian” from the Start menu if needed; the plugin reconnects automatically.";
    if (issue === "incompatible") return INCOMPATIBLE;
    return "Not connected to the companion. If it is not installed yet, install the official Windows companion; otherwise open “ClingNote for Obsidian” from the Start menu. The plugin keeps retrying.";
}

/** One short line (plus at most one action) for the sidebar. Null when no notice is warranted. */
export function connectionNotice(status: ConnectionStatus, issue: string | null, hasDownload: boolean): ConnectionNotice | null {
    if (status === "connected" || status === "connecting") return null;
    const download = hasDownload ? "download" as const : null;
    if (issue === "missing") return { text: "Companion not installed. ClingNote needs it to follow your Windows context.", action: download };
    if (issue === "installed") return { text: "Companion installed but not running. Open “ClingNote for Obsidian” from the Start menu.", action: "retry" };
    if (issue === "interrupted") return { text: "Connection to the companion was interrupted. Reconnecting…", action: "retry" };
    if (issue === "incompatible") return { text: "Companion version not compatible with this plugin. Install the latest companion.", action: download ?? "retry" };
    return { text: "Not connected to the companion.", action: "retry" };
}
