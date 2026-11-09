/** Tree structure excludes selection, observation availability, and live context metadata. */
import type { ContextGroup } from "./types";
export function sidebarStructure(groups: Array<[string, ContextGroup]>, existing: boolean[][], collapsed: string[]): string {
    return JSON.stringify([groups.map(([key, group]) => [key, group.mainNote, group.relatedNotes, group.label, group.header, !!group.navigation]), existing, collapsed]);
}
