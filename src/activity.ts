import type { MappingActivity } from "./types";

export const UNDO_WINDOW_MS = 15 * 60_000;
export function freshActivity(item: MappingActivity, now = Date.now()): boolean {
    return item.undoable && now >= item.at && now - item.at < UNDO_WINDOW_MS;
}
export function activityLabel(item: MappingActivity, now = Date.now()): string {
    const mapping = item.after ?? item.before!;
    const age = Math.max(0, Math.floor((now - item.at) / 60000));
    const time = age < 1 ? "just now" : age < 60 ? `${age}m ago` : new Date(item.at).toLocaleString();
    return `${item.after ? item.before ? "Updated attachments" : "Attached" : "Detached"} “${mapping.notePath}” → ${mapping.label || "Saved context"} · ${time}`;
}
export function quickActivity(items: MappingActivity[]): MappingActivity[] { return items.slice(0, 5); }
