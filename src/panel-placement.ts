import type { Workspace } from "obsidian";

/** Explicit open, or quiet relocation of an already-restored view. Never opens a closed view on startup. */
export async function openLeftPanel(workspace: Workspace, type: string, explicit = true): Promise<void> {
    const existing = workspace.getLeavesOfType(type);
    if (!explicit && (!existing.length || existing.every(candidate => candidate.getRoot() === workspace.leftSplit))) return;
    const leaf = existing.find(candidate => candidate.getRoot() === workspace.leftSplit) ?? workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type, active: explicit });
    // Only retire this plugin's old views after the new view opened successfully.
    for (const old of existing) if (old !== leaf) old.detach();
    if (explicit) await workspace.revealLeaf(leaf);
}
