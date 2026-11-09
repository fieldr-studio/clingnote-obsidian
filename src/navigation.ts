import { statSync } from "node:fs";
import { win32 } from "node:path";
import type { ContextSnapshot, NavigationTarget } from "./types";

// Reverse navigation is display metadata only. Never use it to resolve a mapping.
export function safeLocalPath(path: string): boolean {
    return /^[a-z]:\\/i.test(path) && !/[\x00-\x1f<>"|?*]/.test(path) &&
        !path.slice(2).includes(":") && path.split("\\").every(p => p !== ".." && p !== ".");
}
export function safePage(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && !!parsed.hostname && !parsed.username && !parsed.password &&
            !/[\x00-\x20\\]/.test(url) && !/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url);
    } catch { return false; }
}
const documents = new Set([".txt", ".md", ".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".pbix", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export function fileStamp(path: string, folder: boolean): string | null {
    try {
        if (!safeLocalPath(path)) return null;
        const s = statSync(path, { bigint: true });
        if (folder ? !s.isDirectory() : !s.isFile()) return null;
        return s.ino === 0n ? null : `${s.dev}:${s.ino}:${s.birthtimeNs}`;
    } catch { return null; }
}
export function navigationFor(context: ContextSnapshot): NavigationTarget | undefined {
    if (context.key.startsWith("url:")) {
        // Identity intentionally discarded the original scheme/query. Never invent a hashed query.
        const url = `https://${context.key.slice(4)}`;
        return !context.key.includes("?") && safePage(url) ? { kind: "page", url } : undefined;
    }
    if (!context.key.startsWith("file-id:") || !context.path || !safeLocalPath(context.path)) return undefined;
    const folder = context.pathSource === "ExplorerShellWindowDiscovery";
    const stamp = fileStamp(context.path, folder);
    return stamp ? { kind: folder ? "folder" : "file", path: context.path, stamp } : undefined;
}
export function validNavigation(value: unknown): value is NavigationTarget {
    if (!value || typeof value !== "object") return false;
    const v = value as NavigationTarget;
    return v.kind === "page" ? typeof v.url === "string" && safePage(v.url) :
        (v.kind === "file" || v.kind === "folder") && typeof v.path === "string" && safeLocalPath(v.path) && typeof v.stamp === "string" && /^\d+:\d+:\d+$/.test(v.stamp);
}
export function navigationAllowed(target: NavigationTarget, reveal: boolean, stamp = fileStamp): boolean {
    if (!validNavigation(target)) return false;
    if (target.kind === "page") return !reveal;
    if (stamp(target.path, target.kind === "folder") !== target.stamp) return false;
    return reveal || target.kind === "folder" || documents.has(win32.extname(target.path).toLowerCase());
}

export interface NavigationShell {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
}
/** Explicit saved attachment action. Deliberately has no current-context/client dependency. */
export async function openStoredAttachment(target: NavigationTarget | undefined, reveal: boolean, shell: NavigationShell,
    stamp = fileStamp): Promise<string | null> {
    if (!target || !validNavigation(target)) return "Reverse navigation unavailable for this attachment.";
    if (target.kind !== "page" && stamp(target.path, target.kind === "folder") === null)
        return target.kind === "folder" ? "Attached folder not found or inaccessible." : "Attached file not found or inaccessible.";
    if (!navigationAllowed(target, reveal, stamp)) return "Attached target was replaced or is unsupported. No relink was made.";
    try {
        if (target.kind === "page") await shell.openExternal(target.url);
        else if (reveal) shell.showItemInFolder(target.path);
        else if (await shell.openPath(target.path)) return "Could not open the attached target.";
        return null;
    } catch { return "Could not open the attached target."; }
}
