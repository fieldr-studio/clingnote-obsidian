import { connectionGuidance, downloadUrl, COMPANION_DOWNLOAD_URL } from "./onboarding";
import { App, PluginSettingTab, Setting, TFile, type ToggleComponent } from "obsidian";
import type ClingNotePlugin from "./main";
import { endpointLocation } from "./presentation";
import { freshActivity } from "./activity";
import { renderAccentControls } from "./sidebar-modals";
import { PURCHASE_URL, replyMessage, statusHeadline } from "./license";

export class ClingNoteSettingTab extends PluginSettingTab {
    private unsubscribe?: () => void;
    constructor(app: App, private readonly plugin: ClingNotePlugin) { super(app, plugin); }
    display(): void { this.render(this.containerEl); }
    hide(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }

    render(container: HTMLElement): void {
        this.hide();
        container.empty();
        container.addClass("clingnote-settings");
        const welcome = container.createEl("details", { cls: "clingnote-welcome" });
        welcome.open = this.plugin.mappings.entries().length === 0;
        welcome.createEl("summary", { text: "Attach once. Let the right note follow." });
        welcome.createEl("p", { text: "ClingNote makes your Obsidian notes follow the files, apps, and browser pages you're working on." });
        const steps = welcome.createEl("ol");
        for (const text of ["Start the ClingNote companion.", "Open a file, app, or browser page.", "Open an Obsidian Markdown note.", "Click the note's link icon, then Make this the Main note.", "Use the ClingNote sidebar to add Attached notes. Returning to the context opens Main."]) steps.createEl("li", { text });
        welcome.createEl("p", { text: "Following is optional. Pause anytime; your attachments stay intact." });

        new Setting(container).setName("Following").setHeading();
        let followingToggle: ToggleComponent;
        new Setting(container).setName("Enable automatic following").setDesc("Open the Main note automatically when its context becomes active. Needs a free trial or ClingNote Pro.")
            .addToggle(toggle => { followingToggle = toggle; toggle.setValue(this.plugin.settings.followEnabled).onChange(value => this.plugin.setFollowing(value)); });
        new Setting(container).setName("Show status bar control").setDesc("Click the status to attach, open, or pause.")
            .addToggle(toggle => toggle.setValue(this.plugin.settings.showStatusBar).onChange(async value => {
                this.plugin.settings.showStatusBar = value;
                await this.plugin.persist(); this.plugin.applyStatusBarSetting();
            }));
        new Setting(container).setName("Pause for a while").setDesc("Choose a duration, until restart, or until you resume.")
            .addButton(button => button.setButtonText("Pause…").onClick(() => this.plugin.showPauseOptions()));
        new Setting(container).setName("Panel").setHeading();
        new Setting(container).setName("Show ClingNote panel").setDesc("Opens in the left sidebar. Closing it keeps it closed.").addButton(button => button.setButtonText("Open panel").onClick(() => this.plugin.openGroups()));
        new Setting(container).setName("Appearance").setHeading();
        container.createEl("p", { text: "Accent color for the ClingNote sidebar only.", cls: "setting-item-description" });
        renderAccentControls(container.createDiv(), this.plugin);
        new Setting(container).setName("Current context").setHeading();
        const current = container.createDiv();
        new Setting(container).setName("Connection").setHeading();
        const connection = container.createEl("p");
        container.createEl("p", { text: "The companion is a small Windows program that runs locally on your PC and tells the plugin which app, folder or web page is in front, so the right notes can open. It needs no administrator rights and can start when you sign in. This plugin never downloads, installs, or starts it for you." });
        const official = downloadUrl(COMPANION_DOWNLOAD_URL);
        if (official) container.createEl("a", { text: "Download the official Windows companion", href: official, attr: { target: "_blank", rel: "noopener noreferrer" } });
        else container.createEl("p", { text: "The official download link is not available in this version yet. Install the companion only from an official ClingNote source.", cls: "setting-item-description" });

        new Setting(container).setName("Retry connection").setDesc("Use after installing, starting or restarting the companion. It is never launched automatically.")
            .addButton(button => button.setButtonText("Reconnect").onClick(async () => { await this.plugin.follower.reconnect(); update(); }));
        const advanced = container.createEl("details");
        advanced.createEl("summary", { text: "Advanced · Connection settings" });
        const expected = advanced.createEl("p", { cls: "clingnote-location" });
        let pendingPath = this.plugin.settings.endpointFile;
        const validation = advanced.createEl("p", { cls: "setting-item-description" });
        new Setting(advanced).setName("Endpoint file override").setDesc("Leave blank for automatic discovery. Use a full Windows path; environment-variable text is not expanded.")
            .addText(text => text.setPlaceholder("Automatic discovery").setValue(pendingPath).onChange(value => { pendingPath = value; }))
            .addButton(button => button.setButtonText("Apply").onClick(async () => {
                if (pendingPath.trim() && !endpointLocation(pendingPath)) { validation.setText("Enter an absolute Windows path without environment-variable placeholders."); return; }
                validation.setText("");
                await this.plugin.setEndpointFile(pendingPath.trim()); update();
            }));
        new Setting(container).setName("License & Pro").setHeading();
        const licenseBox = container.createDiv({ cls: "clingnote-license" });
        let licenseSignature = "";
        let pendingKey = "";
        let licenseMessage = "";
        const renderLicense = () => {
            const license = this.plugin.license;
            const signature = JSON.stringify([license.status, license.outdated, license.busy, licenseMessage]);
            if (signature === licenseSignature) return;
            licenseSignature = signature;
            licenseBox.empty();
            const status = license.status;
            licenseBox.createEl("p", { text: license.outdated ? "Update the ClingNote companion to use licensing." : statusHeadline(status) });
            if (licenseMessage) licenseBox.createEl("p", { text: licenseMessage, cls: "setting-item-description", attr: { role: "status" } });
            if (!status) return;
            const run = async (action: "trial" | "activate" | "deactivate" | "refresh", key?: string) => {
                licenseMessage = "Working…"; licenseSignature = ""; renderLicense();
                const reply = action === "refresh" && (status.mode === "free" || status.mode === "trial" || status.mode === "expired") ? await license.refreshStatus() : await license.act(action, key);
                if (action === "activate") pendingKey = ""; // the key is never kept after an attempt
                licenseMessage = replyMessage(reply, action); licenseSignature = ""; renderLicense();
            };
            if (status.mode === "free") new Setting(licenseBox).setName("Start 14-day trial").setDesc("No card needed. One trial per computer, shared with ClingNote for Windows.")
                .addButton(button => button.setButtonText("Start trial").setCta().setDisabled(license.busy).onClick(() => void run("trial")));
            if (status.mode !== "pro") new Setting(licenseBox).setName("License key").setDesc("Sent only to the local companion to activate. It is never saved in your vault.")
                .addText(text => { text.inputEl.type = "password"; text.inputEl.autocomplete = "off"; text.inputEl.spellcheck = false; text.setPlaceholder("Paste your license key").setValue(pendingKey).onChange(value => { pendingKey = value; }); })
                .addButton(button => button.setButtonText("Activate").setDisabled(license.busy).onClick(() => void run("activate", pendingKey)));
            if (status.mode === "pro" || status.leaseExpiresUtc) new Setting(licenseBox).setName("Deactivate").setDesc("Frees this installation's activation so you can use it elsewhere.")
                .addButton(button => button.setButtonText("Deactivate").setDisabled(license.busy).onClick(() => void run("deactivate")));
            new Setting(licenseBox).setName("Refresh status").addButton(button => button.setButtonText("Refresh").setDisabled(license.busy).onClick(() => void run("refresh")));
            if (status.mode !== "pro") licenseBox.createEl("a", { text: "Get ClingNote Pro", href: PURCHASE_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
        };
        new Setting(container).setName("Contexts").setHeading();
        new Setting(container).setName("Manage attached notes").addButton(button => button.setButtonText("Open sidebar").onClick(() => this.plugin.openGroups()));
        container.createEl("p", { text: "Detaching removes only the link. Your Markdown notes are never deleted." });
        const attachments = container.createDiv();
        const historyHeading = container.createDiv({ cls: "clingnote-recent-activity" });
        new Setting(historyHeading).setName("Recent activity").setHeading();
        const history = container.createDiv();
        let lastMappings = "";
        const update = () => {
            followingToggle.setValue(this.plugin.settings.followEnabled);
            current.empty(); this.plugin.renderContext(current);
            renderLicense();
            connection.setText(connectionGuidance(this.plugin.follower.status, this.plugin.follower.connectionIssue));
            expected.setText(`Expected endpoint: ${this.plugin.endpointPath() ?? "Unavailable — set a full Windows endpoint path."}`);
            const entries = this.plugin.mappings.entries();
            const privateState = !!this.plugin.follower.lastState?.pauseReason;
            const recent = this.plugin.mappings.recent();
            const signature = JSON.stringify([this.plugin.mappings.groupEntries(), entries.map(([key, mapping]) => [key, mapping, this.app.vault.getAbstractFileByPath(mapping.notePath) instanceof TFile]), recent, recent.map(item => freshActivity(item)), privateState]);
            if (signature === lastMappings) return;
            lastMappings = signature;
            attachments.empty();
            history.empty();
            if (privateState) { attachments.createEl("p", { text: "Attachments and history are hidden during privacy pause." }); return; }
            if (!recent.length) history.createEl("p", { text: "No recent attachment actions." });
            for (const item of recent) {
                const mapping = item.after ?? item.before!;
                new Setting(history).setName(`${item.after ? item.before ? "Updated attachments" : "Attached" : "Detached"} ${mapping.notePath.replace(/\.md$/i, "")} → ${mapping.label || "Saved context"}`)
                    .setDesc(`${new Date(item.at).toLocaleString()}${freshActivity(item) ? "" : " · Undo expired, unavailable, or already used"}`)
                    .addButton(button => button.setButtonText("Undo attachment change").setDisabled(!freshActivity(item)).onClick(() => this.plugin.undoActivity(item.id)));
            }
            if (!entries.length) attachments.createEl("p", { text: "No attachments yet. Open a note and click its link icon." });
            for (const [key, mapping] of entries) {
                const valid = this.app.vault.getAbstractFileByPath(mapping.notePath) instanceof TFile && mapping.notePath.toLowerCase().endsWith(".md");
                new Setting(attachments).setName(mapping.label || "Saved context").setDesc(`Main: ${mapping.notePath} · ${this.plugin.mappings.group(key)?.relatedNotes.length ?? 0} attached notes${valid ? "" : " · Main missing or unsupported"}`)
                    .addButton(button => button.setButtonText("Open note").setDisabled(!valid).onClick(() => this.plugin.run(this.plugin.follower.openSavedNote(mapping.notePath))))
                    .addButton(button => button.setButtonText("Detach").onClick(() => this.plugin.removeAttachment(key)));
            }
        };
        update();
        this.unsubscribe = this.plugin.onSurfaceRefresh(update);
        container.createEl("p", { cls: "setting-item-description", text: "Windows only. Supported private browsers pause quietly; an unverified privacy state also pauses. Excel, Word, and Power BI use experimental window-title contexts. See README for privacy and compatibility limits." });
    }
}
