import { DEFAULT_SETTINGS, type ClingNoteSettings, type ContextSnapshot, type ContextState, type MappingData } from "./types";
import { validNavigation } from "./navigation";

export function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 262144;
function snapshot(value: unknown): value is ContextSnapshot | null {
    return value === null || (record(value) && (value.type === "file" || value.type === "window") &&
        text(value.key) && value.key.length > 0 && (value.path === null || text(value.path)) &&
        text(value.process) && text(value.title) && text(value.pathSource) &&
        Number.isSafeInteger(value.hwnd) && Number.isSafeInteger(value.pid) && (value.pid as number) >= 0);
}
export function contextState(value: unknown): value is ContextState {
    return record(value) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0 &&
        (value.pauseReason === null || value.pauseReason === "private-browsing") &&
        (value.pauseDetail === undefined || value.pauseDetail === null ||
            (value.pauseReason !== null && (value.pauseDetail === "confirmed-private" || value.pauseDetail === "verifying-context"))) &&
        snapshot(value.current) && snapshot(value.lastExternal) &&
        (value.availability === undefined || value.availability === null || (
            ["ready", "none", "private", "privacy-unknown", "identity-unavailable"].includes(value.availability as string) &&
            snapshot(value.acceptedTarget) &&
            (value.availability !== "ready" || (value.acceptedTarget !== null && value.pauseReason === null)) &&
            (value.availability !== "none" || (value.acceptedTarget === null && value.pauseReason === null)) &&
            (value.availability !== "private" || (value.acceptedTarget === null && value.current === null && value.lastExternal === null))
        )) &&
        (value.pauseReason === null || value.current === null);
}
export function notePath(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.toLowerCase().endsWith(".md") &&
        !/[\\:\x00-\x1f]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function header(value: unknown): boolean {
    return record(value) && (value.mode === "context" || value.mode === "hidden" ||
        (value.mode === "custom" && typeof value.label === "string" && value.label.trim().length > 0 && value.label.length <= 200));
}
function related(value: unknown, main: unknown): boolean {
    return typeof main === "string" && Array.isArray(value) && value.every(notePath) && !value.includes(main) && new Set(value).size === value.length;
}
function activityMapping(value: unknown): boolean {
    return record(value) && notePath(value.notePath) && typeof value.label === "string" &&
        (value.navigation === undefined || validNavigation(value.navigation)) &&
        (value.relatedNotes === undefined || related(value.relatedNotes, value.notePath)) &&
        (value.header === undefined || header(value.header));
}

/** Reject damaged persisted data without silently replacing it on the next settings save. */
export function persistedData(value: unknown): { settings: ClingNoteSettings; mappings?: MappingData; firstRun: boolean } {
    if (value == null) return { settings: { ...DEFAULT_SETTINGS }, firstRun: true };
    if (!record(value)) throw new Error("Invalid plugin data");
    const settings = { ...DEFAULT_SETTINGS };
    if (value.settings !== undefined) {
        if (!record(value.settings)) throw new Error("Invalid settings");
        for (const key of ["followEnabled", "showStatusBar", "showUnmappedHint"] as const) {
            if (value.settings[key] !== undefined) {
                if (typeof value.settings[key] !== "boolean") throw new Error("Invalid setting type");
                settings[key] = value.settings[key];
            }
        }
        const notices = value.settings.licenseNotices;
        if (record(notices)) settings.licenseNotices = { ...(notices.welcome === true ? { welcome: true } : {}), ...(notices.soon === true ? { soon: true } : {}), ...(notices.expired === true ? { expired: true } : {}) };
        const ui = value.settings.ui;
        if (ui !== undefined && record(ui)) {   // presentation only: sanitize rather than reject
            settings.ui = {
                collapsed: Array.isArray(ui.collapsed) ? ui.collapsed.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length < 4096).slice(0, 500) : [],
                unattachedExpanded: ui.unattachedExpanded === true,
                sort: ui.sort === "name" ? "name" : "created",
                ...(typeof ui.accent === "string" && /^#[0-9a-f]{6}$/i.test(ui.accent) ? { accent: ui.accent.toLowerCase() } : {}),
                ...(ui.sidebarActivated === true ? { sidebarActivated: true } : {}),
            };
        }
        const pause = value.settings.pause;
        if (pause !== undefined) {
            if (!record(pause) || !(pause.kind === "indefinite" ||
                (pause.kind === "timed" && Number.isSafeInteger(pause.until) && (pause.until as number) > 0) ||
                (pause.kind === "restart" && typeof pause.session === "string" && pause.session.length < 200))) throw new Error("Invalid pause");
            settings.pause = pause as ClingNoteSettings["pause"];
        }
        if (value.settings.endpointFile !== undefined) {
            if (typeof value.settings.endpointFile !== "string") throw new Error("Invalid endpoint setting");
            settings.endpointFile = value.settings.endpointFile;
        }
    }
    if (value.mappings !== undefined) {
        const data = value.mappings;
        if (!record(data) || (data.version !== 1 && data.version !== 2)) throw new Error("Unsupported mapping data");
        if (data.version === 1) {
            if (!record(data.mappings)) throw new Error("Invalid legacy mappings");
            for (const [key, item] of Object.entries(data.mappings)) if (!key || !activityMapping(item)) throw new Error("Invalid mapping entry");
        } else {
            if (!record(data.groups)) throw new Error("Invalid groups");
            for (const [key, group] of Object.entries(data.groups)) if (!key || !record(group) || !notePath(group.mainNote) ||
                typeof group.label !== "string" || !related(group.relatedNotes, group.mainNote) || !header(group.header) ||
                (group.navigation !== undefined && !validNavigation(group.navigation))) throw new Error("Invalid context group");
        }
        if (data.activity !== undefined) {
            if (!Array.isArray(data.activity) || data.activity.length > 20) throw new Error("Invalid activity");
            const ids = new Set<number>();
            for (const item of data.activity) {
                if (!record(item) || !Number.isSafeInteger(item.id) || (item.id as number) < 1 || ids.has(item.id as number) ||
                    !Number.isSafeInteger(item.at) || typeof item.key !== "string" || !item.key || typeof item.undoable !== "boolean" ||
                    (!item.before && !item.after)) throw new Error("Invalid activity entry");
                ids.add(item.id as number);
                for (const mapping of [item.before, item.after]) if (mapping !== undefined && !activityMapping(mapping)) throw new Error("Invalid activity mapping");
            }
        }
    }
    return { settings, mappings: value.mappings as MappingData | undefined, firstRun: !value.settings && !value.mappings };
}
