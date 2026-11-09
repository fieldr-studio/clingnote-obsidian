import { win32 } from "node:path";
import type { ConnectionStatus, ContextSnapshot, ContextState } from "./types";
import type { PauseState } from "./types";
import { pauseLabel } from "./pause";
import { contextAccess } from "./context-policy";
import { notePath as validNotePath } from "./validation";

/** UI explanations only; eligibility and identity remain owned by contextAccess. */
export function attachExplanation(status: ConnectionStatus, state: ContextState | null, notePath?: string): string {
    const access = contextAccess(status, state);
    if (access.kind === "private") return "Unavailable in private browsing";
    if (access.kind === "disconnected") return "ClingNote companion is disconnected";
    if (access.kind === "connecting") return "Connecting to the ClingNote companion…";
    if (access.kind === "privacy-unknown") return "Checking the browser page…";
    if (access.kind === "identity-unavailable") return "This window has no readable page or file address yet";
    if (!access.target) return "Open a file, app, folder, or browser page first";
    if (!validNotePath(notePath)) return "Open a Markdown note first";
    return "";
}

export function panelContext(status: ConnectionStatus, state: ContextState | null): { heading: string; title: string; location: string; detail: string } {
    const access = contextAccess(status, state);
    if (access.kind === "private") return { heading: "Private browsing", title: "", location: "", detail: "Unavailable in private browsing" };
    if (!access.accepted) return { heading: access.kind === "none" ? "No active context" : "Current context", title: "", location: "",
        detail: access.kind === "none" ? "Switch to a file, app, folder, or browser page." : attachExplanation(status, state) };
    const info = describeContext(access.accepted);
    const app = ({ "chrome.exe": "Chrome", "msedge.exe": "Edge", "brave.exe": "Brave", "vivaldi.exe": "Vivaldi", "explorer.exe": "Explorer", "excel.exe": "Excel", "winword.exe": "Word", "notepad.exe": "Notepad" } as Record<string, string>)[access.accepted.process.toLowerCase()] ?? access.accepted.process.replace(/\.exe$/i, "");
    return { heading: "Current context", title: `${app} · ${info.title}`, location: info.location,
        detail: access.target ? "" : "Temporarily unavailable" };
}

/** Presentation only: never creates or normalizes a mapping key. */
export function describeContext(context: ContextSnapshot): { kind: string; title: string; location: string } {
    if (context.key.startsWith("url:")) return {
        kind: "Browser", title: context.title || "Browser page",
        location: context.key.slice(4).replace(/\?~[^#]*/, ""),
    };
    if (context.path) return {
        kind: context.pathSource === "ExplorerShellWindowDiscovery" ? "Folder" : "File",
        title: context.path.split(/[\\/]/).pop() || context.path, location: context.path,
    };
    return { kind: "App", title: context.title || context.process, location: context.process };
}

export function safeTarget(status: ConnectionStatus, state: ContextState | null): ContextSnapshot | null {
    return contextAccess(status, state).target;
}

export function compactStatus(status: ConnectionStatus, state: ContextState | null, following: boolean, mapped: boolean,
    pause?: PauseState, showUnmappedHint = true, now = Date.now()): string {
    if (status === "disconnected") return "ClingNote: Disconnected";
    if (status === "connecting") return "ClingNote: Connecting…";
    const access = contextAccess(status, state);
    if (access.kind === "private") return "ClingNote: Private browsing";
    if (access.kind === "privacy-unknown" || access.kind === "identity-unavailable") return "ClingNote: Context unavailable";
    if (!following) return "ClingNote: Paused";
    if (!access.target) return "ClingNote: No context";
    return mapped ? "ClingNote: Following" : showUnmappedHint ? "ClingNote: No note attached" : "ClingNote: Ready";
}

export function endpointLocation(override: string, localAppData?: string): string | null {
    const custom = override.trim();
    if (custom) return win32.isAbsolute(custom) && !custom.includes("%") ? custom : null;
    return localAppData && win32.isAbsolute(localAppData) ? win32.join(localAppData, "ClingNote.Context", "endpoint.json") : null;
}
