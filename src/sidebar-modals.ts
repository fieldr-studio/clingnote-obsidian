import { App, FuzzySuggestModal, Modal, SuggestModal, TFile, getIconIds, setIcon } from "obsidian";
import type ClingNotePlugin from "./main";
import { baseName, contextTitle, iconOf } from "./sidebar-model";
import { validIcon } from "./mappings";
import { ACCENT_PRESETS, normalizeAccent } from "./accent";

/** Common Lucide icons offered first; any other Lucide name can be typed. */
const COMMON_ICONS = ["globe", "file", "file-text", "folder", "app-window", "book-open", "bookmark", "briefcase", "calendar", "chart-bar",
    "clipboard-list", "code", "database", "flask-conical", "graduation-cap", "hammer", "heart", "house", "inbox", "lightbulb", "link",
    "mail", "map", "message-square", "microscope", "music", "newspaper", "palette", "pen-line", "presentation", "rocket", "search",
    "shopping-cart", "sparkles", "star", "table", "target", "terminal", "users", "wallet", "wrench", "zap"];

/** Pick a Lucide icon (searchable) or type an emoji, or restore the default. Display data only. */
export class IconPickerModal extends Modal {
    constructor(app: App, private readonly plugin: ClingNotePlugin, private readonly key: string) { super(app); }
    onOpen(): void {
        const group = this.plugin.mappings.group(this.key);
        if (!group) { this.close(); return; }
        this.titleEl.setText("Context icon");
        this.contentEl.addClass("clingnote-icon-picker");
        this.contentEl.createEl("p", { text: `For “${contextTitle(group).title}”. This changes only how the context looks, never what it follows.`, cls: "setting-item-description" });
        const search = this.contentEl.createEl("input", { type: "text", attr: { placeholder: "Search Lucide icons…", "aria-label": "Search icons" } });
        const grid = this.contentEl.createDiv({ cls: "clingnote-icon-grid" });
        const all = (() => { try { return getIconIds().filter(id => id.startsWith("lucide-")).map(id => id.slice(7)); } catch { return COMMON_ICONS; } })();
        const choose = (icon: string | null) => { this.close(); void this.plugin.run(this.plugin.follower.changeGroup(this.key, { kind: "icon", icon })); };
        const draw = () => {
            grid.empty();
            const q = search.value.trim().toLowerCase();
            const names = (q ? all.filter(n => n.includes(q)) : COMMON_ICONS.filter(n => all.includes(n))).slice(0, 96);
            if (!names.length) grid.createEl("p", { text: "No matching icon.", cls: "setting-item-description" });
            for (const name of names) {
                const button = grid.createEl("button", { cls: "clickable-icon clingnote-icon-choice", attr: { "aria-label": name, title: name, type: "button" } });
                setIcon(button, name); button.onclick = () => choose(`lucide:${name}`);
            }
        };
        search.oninput = draw; draw();
        const emojiRow = this.contentEl.createDiv({ cls: "clingnote-icon-emoji" });
        const emoji = emojiRow.createEl("input", { type: "text", attr: { placeholder: "…or type an emoji", maxlength: "16", "aria-label": "Emoji icon" } });
        const use = emojiRow.createEl("button", { text: "Use emoji" });
        const note = this.contentEl.createEl("p", { cls: "setting-item-description" });
        use.onclick = () => { const icon = `emoji:${emoji.value.trim()}`; if (validIcon(icon)) choose(icon); else note.setText("Enter an emoji (letters and digits alone are not an icon)."); };
        emoji.onkeydown = event => { if (event.key === "Enter") use.click(); };
        const restore = this.contentEl.createEl("button", { text: "Restore default icon" });
        restore.onclick = () => choose(null);
        search.focus();
    }
}

/** Pick one existing context (group). Used from the note side: "Attach to another context…". */
export class ContextSuggestModal extends SuggestModal<{ key: string; title: string }> {
    constructor(app: App, private readonly choices: Array<{ key: string; title: string }>, private readonly onPick: (key: string) => void, placeholder = "Attach to which context?") {
        super(app); this.setPlaceholder(placeholder);
    }
    getSuggestions(query: string) { const q = query.toLowerCase(); return this.choices.filter(c => c.title.toLowerCase().includes(q)); }
    renderSuggestion(value: { key: string; title: string }, el: HTMLElement): void { el.setText(value.title); }
    onChooseSuggestion(value: { key: string; title: string }): void { this.onPick(value.key); }
}

/** Pick an existing Markdown note. Used from the context side: "Attach existing note…". */
export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
    constructor(app: App, private readonly candidates: TFile[], private readonly onPick: (path: string) => void) {
        super(app); this.setPlaceholder("Attach which note?");
    }
    getItems(): TFile[] { return this.candidates; }
    getItemText(file: TFile): string { return file.path.replace(/\.md$/i, ""); }
    onChooseItem(file: TFile): void { this.onPick(file.path); }
}

/** Where a note lives: every context it belongs to, with jump and unlink controls. Same data as the sidebar tree. */
export class AttachedContextsModal extends Modal {
    private unsubscribe?: () => void;
    constructor(app: App, private readonly plugin: ClingNotePlugin, private readonly path: string) { super(app); }
    onOpen(): void {
        this.titleEl.setText(`Contexts for “${baseName(this.path)}”`);
        this.unsubscribe = this.plugin.onSurfaceRefresh(() => this.render());
        this.render();
    }
    onClose(): void { this.unsubscribe?.(); }
    private render(): void {
        const el = this.contentEl; el.empty(); el.addClass("clingnote-attached-contexts");
        if (this.plugin.follower.lastState?.pauseReason) { el.createEl("p", { text: "Unavailable during privacy pause.", cls: "setting-item-description" }); return; }
        const contexts = this.plugin.mappings.contextsForNote(this.path);
        el.createEl("p", { cls: "setting-item-description", text: contexts.length
            ? "This is one Markdown file. Editing it from any context changes the same note everywhere." : "This note is not attached to any context." });
        for (const { key, group, main } of contexts) {
            const row = el.createDiv({ cls: "clingnote-attached-row" });
            const icon = row.createSpan({ cls: "clingnote-group-icon" });
            this.plugin.paintIcon(icon, iconOf(key, group).icon);
            row.createSpan({ text: contextTitle(group).title, cls: "clingnote-attached-title" });
            row.createSpan({ text: main ? "Main here" : "Attached", cls: "clingnote-main-label" });
            const go = row.createEl("button", { text: "Show in sidebar" });
            go.onclick = () => { this.close(); void this.plugin.revealContext(key, true); };
            if (!main) {
                const makeMain = row.createEl("button", { text: "Make Main" });
                makeMain.onclick = () => void this.plugin.run(this.plugin.follower.changeGroup(key, { kind: "main", path: this.path }));
            }
            const remove = row.createEl("button", { text: "Remove from this context" });
            remove.onclick = () => void this.plugin.run(this.plugin.follower.changeGroup(key, { kind: "remove", path: this.path }));
        }
    }
}

/** Accent swatches, optional custom color and restore-default, with instant preview. Used by the sidebar menu and settings. */
export function renderAccentControls(container: HTMLElement, plugin: ClingNotePlugin): void {
    container.empty();
    const row = container.createDiv({ cls: "clingnote-accent-row" });
    const current = () => normalizeAccent(plugin.ui().accent);
    const select = (value: string | undefined) => { void plugin.setAccent(value).then(() => renderAccentControls(container, plugin)); };
    const def = row.createEl("button", { cls: "clingnote-swatch is-default", attr: { "aria-label": "Default (Obsidian accent)", title: "Default (Obsidian accent)", type: "button" } });
    def.toggleClass("is-selected", !current());
    def.onclick = () => select(undefined);
    for (const preset of ACCENT_PRESETS) {
        const swatch = row.createEl("button", { cls: "clingnote-swatch", attr: { "aria-label": preset.name, title: preset.name, type: "button" } });
        swatch.style.setProperty("--swatch", preset.value);
        swatch.toggleClass("is-selected", current() === preset.value);
        swatch.onclick = () => select(preset.value);
        swatch.onmouseenter = () => plugin.applyAccent(preset.value);
        swatch.onmouseleave = () => plugin.applyAccent();
    }
    const custom = container.createDiv({ cls: "clingnote-accent-custom" });
    custom.createSpan({ text: "Custom" });
    const input = custom.createEl("input", { type: "color", attr: { "aria-label": "Custom accent color" } });
    input.value = current() ?? "#7c3aed";
    input.oninput = () => plugin.applyAccent(input.value);           // instant preview
    input.onchange = () => select(input.value);                       // saved when the picker closes
    const restore = custom.createEl("button", { text: "Restore default" });
    restore.disabled = !current();
    restore.onclick = () => select(undefined);
}

export class AccentModal extends Modal {
    constructor(app: App, private readonly plugin: ClingNotePlugin) { super(app); }
    onOpen(): void {
        this.titleEl.setText("ClingNote accent color");
        this.contentEl.createEl("p", { text: "Used for the active-context highlight, Main-note star and selections in ClingNote only. Obsidian's theme and other plugins are not changed.", cls: "setting-item-description" });
        renderAccentControls(this.contentEl.createDiv(), this.plugin);
    }
    onClose(): void { this.plugin.applyAccent(); }
}
