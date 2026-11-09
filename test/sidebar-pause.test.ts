import test from "node:test";
import assert from "node:assert/strict";
import { MappingStore } from "../src/mappings";
import { attachmentTarget } from "../src/context-policy";
import { toggleGroup, DEFAULT_UI } from "../src/sidebar-model";
import type { ContextState, SidebarUiState } from "../src/types";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

// Same small DOM seam as sidebar-stability: the real view renderer runs against it.
class Element {
    children: Element[] = []; dataset: Record<string, string> = {}; classes = new Set<string>();
    attrs: Record<string, string> = {}; hidden = false; inert = false; disabled = false; scrollTop = 0;
    text = ""; empties = 0; parent?: Element; scrolled = 0;
    createDiv(options: any = {}) { return this.createEl("div", typeof options === "string" ? { cls: options } : options); }
    createSpan(options: any = {}) { return this.createEl("span", options); }
    hasClass(name: string) { return this.classes.has(name); }
    closest(selector: string): Element | null { for (let el: Element | undefined = this; el; el = el.parent) if (el.classes.has(selector.slice(1))) return el; return null; }
    createEl(_tag: string, options: any = {}) { const el = new Element(); el.parent = this; for (const c of (options.cls ?? "").split(" ")) if (c) el.classes.add(c); el.text = options.text ?? ""; el.attrs = options.attr ?? {}; this.children.push(el); return el; }
    addClass(name: string) { this.classes.add(name); }
    removeClass(...names: string[]) { names.forEach(n => this.classes.delete(n)); }
    toggleClass(name: string, enabled: boolean) { enabled ? this.classes.add(name) : this.classes.delete(name); }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    setText(value: string) { this.text = value; }
    empty() { this.empties++; this.children = []; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(el => [...(el.classes.has(selector.slice(1)) ? [el] : []), ...el.querySelectorAll(selector)]); }
    static total = 0;
    scrollIntoView() { this.scrolled++; Element.total++; }
}

const A = { ...snapshot("chrome.exe", "A"), key: "url:example.test/a" };
const B = { ...snapshot("chrome.exe", "B"), key: "url:example.test/b" };
const readyState = (target: typeof A, seq: number): ContextState => ({ seq, current: target, lastExternal: target, pauseReason: null, pauseDetail: null, acceptedTarget: target, availability: "ready" });

async function setup() {
    class File {}
    const app = { workspace: { getActiveFile: () => ({ path: "A1.md" }), on: () => ({}) },
        vault: { getAbstractFileByPath: () => new File(), getMarkdownFiles: () => ["A1.md", "A2.md", "B1.md"].map(path => ({ path })), on: () => ({}) } };
    const module = require("node:module") as any, original = module._load;
    module._load = function(name: string, ...rest: any[]) {
        if (name === "obsidian") return { ItemView: class { app = app; contentEl = new Element(); registerEvent() {} }, TFile: File, setIcon() {}, setTooltip() {}, Menu: class {}, Modal: class {} };
        return original.call(this, name, ...rest);
    };
    let View: any;
    try { View = require("../src/group-view").ContextGroupView; } finally { module._load = original; }
    const store = new MappingStore(); store.attach(A.key, "A1.md", "A"); store.addNote(A.key, "A2.md", "A"); store.attach(B.key, "B1.md", "B");
    const service = new FakeService(), host = new FakeHost(); ["A1.md", "A2.md", "B1.md"].forEach(f => host.files.add(f)); host.active = "Z.md";
    let following = true, ui: SidebarUiState = { ...DEFAULT_UI, collapsed: [B.key] };
    let refresh = () => {};
    const { follower } = makeFollower(service, host, { mappings: store, follow: () => following });
    const plugin: any = { license: { entitled: () => true, status: null, outdated: false }, follower, mappings: store, settings: { get followEnabled() { return following; } },
        ui: () => ui, paintIcon() {}, contextName: (g: any) => g.label, notify() {}, run: (p: Promise<unknown>) => p,
        onSurfaceRefresh: (cb: () => void) => { refresh = cb; return () => {}; },
        attachTarget: (path: string) => attachmentTarget(follower.status, follower.lastState, path),
        toggleGroup: (key: string, expanded: boolean) => { ui = toggleGroup(ui, key, expanded); refresh(); },
        setFollowing: async (value: boolean) => { following = value; await follower.refresh(); refresh(); } };
    const view = new View({}, plugin); await view.onOpen();
    const tick = async (state: ContextState) => { service.state = state; await follower.step(); refresh(); };
    return { view, plugin, store, service, host, follower, tick, setFollowing: async (v: boolean) => { await plugin.setFollowing(v); },
        groups: () => (view.bodyEl as Element).querySelectorAll(".clingnote-group"),
        active: () => (view.bodyEl as Element).querySelectorAll(".clingnote-group").filter(g => g.classes.has("is-active-context")).map(g => g.dataset.contextKey),
        scrolls: () => Element.total,
        rows: () => (view.bodyEl as Element).querySelectorAll(".clingnote-group-note").map(r => r.dataset.notePath) };
}

test("0.17.1 pause: the following highlight clears at once, nothing expands or scrolls, and no note opens while paused", async () => {
    const s = await setup();
    await s.tick(readyState(A, 1));
    assert.deepEqual(s.active(), [A.key]);
    assert.deepEqual(s.host.opened, ["A1.md"], "normal following opened A's Main before the pause");
    const scrollsBefore = s.scrolls();
    await s.setFollowing(false);
    assert.equal(s.view.pausedBadge.hidden, false, "a small Paused indicator is shown");
    assert.equal(s.view.contentEl.classes.has("is-paused"), true);
    assert.deepEqual(s.active(), [], "the purple active-context highlight clears immediately on pause");
    assert.equal((s.view.bodyEl as Element).querySelectorAll(".clingnote-group-note").some(r => r.classes.has("is-active-main")), false, "and so does the Main emphasis");
    assert.equal(s.rows().includes("A1.md"), true, "expansion is unchanged");
    // Windows context moves to B (whose group the user collapsed) and later to an unmapped app.
    await s.tick(readyState(B, 2));
    assert.deepEqual(s.active(), [], "no highlight returns as the context changes while paused");
    assert.equal(s.rows().includes("B1.md"), false, "B stays collapsed: no automatic expand");
    assert.equal(s.scrolls(), scrollsBefore, "no automatic scroll");
    await s.tick(readyState({ ...snapshot("notepad.exe", "n"), key: "window:notepad.exe|N" } as any, 3));
    assert.deepEqual(s.active(), []);
    assert.deepEqual(s.host.opened, ["A1.md"], "no further note is opened while paused");
    // The follower keeps receiving observations internally.
    assert.equal(s.follower.lastState?.seq, 3);
    assert.equal(s.follower.decisions.some(d => d.outcome === "following paused"), true);
});

test("0.17.1 pause: users can still navigate, expand, customize and manage notes manually", async () => {
    const s = await setup();
    await s.tick(readyState(A, 1));
    s.host.opened.length = 0;
    await s.setFollowing(false);
    await s.tick(readyState(B, 2));
    s.plugin.toggleGroup(B.key, true);                       // manual expand
    assert.equal(s.rows().includes("B1.md"), true);
    assert.deepEqual(s.active(), [], "manual expansion brings no highlight back");
    assert.equal((await s.follower.changeGroup(B.key, { kind: "header", header: { mode: "custom", label: "Renamed while paused" } })).ok, true);
    assert.equal((await s.follower.changeGroup(A.key, { kind: "icon", icon: "lucide:globe" })).ok, true);
    assert.equal((await s.follower.changeGroup(B.key, { kind: "insert", path: "A2.md" })).ok, true, "valid attachments can be managed");
    s.view.render(true);
    assert.deepEqual(s.store.contextsForNote("A2.md").map(c => c.key).sort(), [A.key, B.key].sort());
    assert.deepEqual(s.active(), []);
    assert.equal(s.host.opened.length, 0);
});

test("0.17.1 pause: resuming reconciles with the latest verified context, updates highlight and scroll, and follows again", async () => {
    const s = await setup();
    await s.tick(readyState(A, 1));
    await s.setFollowing(false);
    await s.tick(readyState(B, 2));
    assert.deepEqual(s.active(), []);
    const scrollsBefore = s.scrolls();
    s.host.opened.length = 0;
    await s.setFollowing(true);
    assert.deepEqual(s.active(), [B.key], "highlight jumps to the current context");
    assert.equal(s.rows().includes("B1.md"), true, "the collapsed active group is shown again (session only)");
    assert.ok(s.scrolls() > scrollsBefore, "and scrolled into view");
    assert.deepEqual(s.host.opened, ["B1.md"], "normal following resumes: the Main note of the current context opens");
    assert.deepEqual(s.plugin.ui().collapsed, [B.key], "the saved collapse choice is untouched");
});

test("0.17.1 pause: private or unverified context never leaks through the frozen highlight, and resume does not reuse it", async () => {
    const s = await setup();
    await s.tick(readyState(A, 1));
    s.host.opened.length = 0;
    await s.setFollowing(false);
    await s.tick({ seq: 2, current: null, lastExternal: null, pauseReason: "private-browsing", pauseDetail: "confirmed-private", acceptedTarget: null, availability: "private" });
    assert.equal(s.view.bodyEl.hidden, true, "tree hidden during private browsing even while paused");
    await s.tick(readyState(B, 3));
    assert.equal(s.view.bodyEl.hidden, false);
    assert.deepEqual(s.active(), [], "nothing observed while private is highlighted while paused");
    await s.tick({ seq: 4, current: null, lastExternal: null, pauseReason: "private-browsing", pauseDetail: "confirmed-private", acceptedTarget: null, availability: "private" });
    s.service.state = { seq: 4, current: null, lastExternal: null, pauseReason: "private-browsing", pauseDetail: "confirmed-private", acceptedTarget: null, availability: "private" };
    await s.setFollowing(true);
    assert.equal(s.view.bodyEl.hidden, true, "resuming into a private window shows nothing and highlights nothing");
    assert.equal(s.host.opened.length, 0);
});
