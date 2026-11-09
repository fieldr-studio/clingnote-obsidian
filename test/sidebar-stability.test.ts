import test from "node:test";
import assert from "node:assert/strict";
import { MappingStore } from "../src/mappings";
import { attachmentTarget } from "../src/context-policy";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

// Small DOM/Obsidian host seam: exercise the actual view renderer, not a copy of its policy.
class Element {
    children: Element[] = []; dataset: Record<string, string> = {}; classes = new Set<string>();
    attrs: Record<string, string> = {}; hidden = false; inert = false; disabled = false; scrollTop = 37;
    text = ""; empties = 0;
    createDiv(options: any = {}) { return this.createEl("div", typeof options === "string" ? { cls: options } : options); }
    createSpan(options: any = {}) { return this.createEl("span", options); }
    parent?: Element; scrolled = 0;
    hasClass(name: string) { return this.classes.has(name); }
    closest(selector: string): Element | null { for (let el: Element | undefined = this; el; el = el.parent) if (el.classes.has(selector.slice(1))) return el; return null; }
    createEl(_tag: string, options: any = {}) { const el = new Element(); el.parent = this; for (const c of (options.cls ?? "").split(" ")) if (c) el.classes.add(c); el.text = options.text ?? ""; el.attrs = options.attr ?? {}; this.children.push(el); return el; }
    addClass(name: string) { this.classes.add(name); }
    removeClass(name: string) { this.classes.delete(name); }
    toggleClass(name: string, enabled: boolean) { enabled ? this.classes.add(name) : this.classes.delete(name); }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    setText(value: string) { this.text = value; }
    empty() { this.empties++; this.children = []; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(el => [...(el.classes.has(selector.slice(1)) ? [el] : []), ...el.querySelectorAll(selector)]); }
    scrollIntoView() { this.scrolled++; }
}

test("0.17 sidebar: every context is listed, rows survive observation changes, Main is first, active group is highlighted and privacy hides everything", async () => {
    class File {}
    const a = { ...snapshot("chrome.exe", "A"), key: "url:example.test/a" };
    const b = { ...snapshot("chrome.exe", "B"), key: "url:example.test/other" };
    let active = "Main.md", refresh = () => {};
    const app = { workspace: { getActiveFile: () => ({ path: active }), on: () => ({}) },
        vault: { getAbstractFileByPath: () => new File(), getMarkdownFiles: () => ["Main.md", "Related.md", "Other-context.md", "Loose.md"].map(path => ({ path })), on: () => ({}) } };
    const module = require("node:module") as any, original = module._load;
    module._load = function(name: string, ...rest: any[]) {
        if (name === "obsidian") return { ItemView: class { app = app; contentEl = new Element(); registerEvent() {} }, TFile: File, setIcon(el: Element, name: string) { el.attrs.icon = name; }, setTooltip() {}, Menu: class {}, Modal: class {} };
        return original.call(this, name, ...rest);
    };
    let View: any;
    try { View = require("../src/group-view").ContextGroupView; } finally { module._load = original; }
    const mappings = new MappingStore(); mappings.attach(a.key, "Main.md", "A"); mappings.addNote(a.key, "Related.md", "A");
    mappings.attach(b.key, "Other-context.md", "Other");
    const follower: any = { status: "connected", lastState: { seq: 1, current: a, lastExternal: a, acceptedTarget: a, availability: "ready", pauseReason: null } };
    const plugin: any = { license: { entitled: () => true, status: null, outdated: false }, follower, mappings, settings: { followEnabled: true }, ui: () => ({ collapsed: [], unattachedExpanded: true, sort: "created" }),
        paintIcon: () => {}, onSurfaceRefresh: (cb: () => void) => { refresh = cb; return () => {}; },
        attachTarget: (path: string) => attachmentTarget(follower.status, follower.lastState, path) };
    const view = new View({}, plugin); await view.onOpen();
    const body = view.bodyEl as Element;
    const noteRows = () => body.querySelectorAll(".clingnote-group-note");
    const groups = () => body.querySelectorAll(".clingnote-group");
    assert.deepEqual(noteRows().map(row => row.dataset.notePath), ["Main.md", "Related.md", "Other-context.md", "Loose.md"], "all contexts, then Unattached");
    assert.equal(groups().length, 2, "other contexts are not hidden");
    assert.equal(groups().filter(g => g.classes.has("is-active-context")).length, 1);
    assert.equal(groups().find(g => g.classes.has("is-active-context"))!.dataset.contextKey, a.key);
    assert.equal(noteRows()[0].classes.has("is-active-main"), true, "active group's Main is highlighted");
    assert.equal(noteRows()[2].classes.has("is-active-main"), false);
    assert.equal(noteRows()[0].children[0].attrs.icon, "star");
    assert.equal(view.addButton.disabled, false);
    const initialEmpty = body.empties, main = noteRows()[0];
    active = "Related.md"; refresh();
    assert.equal(noteRows()[0], main, "selection change does not rebuild rows");
    assert.equal(noteRows()[1].classes.has("is-current-note"), true);
    follower.lastState = { ...follower.lastState, acceptedTarget: { ...a, title: "new title" }, current: { ...a, title: "new title" }, seq: 2 }; refresh();
    for (const availability of ["privacy-unknown", "identity-unavailable"]) {
        follower.lastState = { ...follower.lastState, acceptedTarget: a, current: null, availability, pauseReason: "private-browsing", pauseDetail: "verifying-context" }; refresh();
        assert.equal(body.hidden, false); assert.equal(view.addButton.disabled, true, "unverified context cannot attach");
        assert.equal(view.statusEl.text, availability === "privacy-unknown" ? "Checking the browser page…" : "This window has no readable page or file address yet");
    }
    follower.lastState = { ...follower.lastState, acceptedTarget: null, availability: "private", pauseDetail: "confirmed-private" }; refresh();
    assert.equal(body.hidden, true); assert.equal(body.inert, true, "private browsing hides and disables the whole tree");
    follower.lastState = { ...follower.lastState, acceptedTarget: a, current: a, availability: "ready", pauseReason: null, pauseDetail: null }; refresh();
    assert.equal(body.hidden, false); assert.equal(view.addButton.disabled, false);
    assert.equal(body.empties, initialEmpty, "no structural redraw for any observation/selection transition");
    assert.equal(noteRows()[0], main);
    assert.equal(view.contentEl.scrollTop, 37);
    // Main changes in one context reorder only that context.
    mappings.makeMain(a.key, "Related.md"); refresh();
    assert.deepEqual(noteRows().map(row => row.dataset.notePath), ["Related.md", "Main.md", "Other-context.md", "Loose.md"]);
    assert.equal(noteRows()[0].classes.has("is-main"), true);
    // Switching the Windows context moves the highlight; unrelated groups stay listed and are not collapsed.
    follower.lastState = { ...follower.lastState, acceptedTarget: b, current: b, seq: 4 }; refresh();
    assert.equal(groups().find(g => g.classes.has("is-active-context"))!.dataset.contextKey, b.key);
    assert.equal(noteRows().length, 4, "both contexts remain expanded");
    assert.ok(groups().some(g => g.scrolled > 0), "newly active group is scrolled into view");
    follower.lastState = { ...follower.lastState, acceptedTarget: { ...a, key: "url:example.test/unmapped" }, seq: 5 }; refresh();
    assert.equal(groups().filter(g => g.classes.has("is-active-context")).length, 0, "an unmapped context highlights nothing and borrows no notes");
    // The header + button dispatches the existing safety-gated follower operations.
    const service = new FakeService(), host = new FakeHost();
    host.files = new Set(["A.md", "B.md", "C.md"]); host.active = active = "A.md";
    const actual = makeFollower(service, host); service.set(a); await actual.follower.step();
    plugin.follower = actual.follower; plugin.mappings = actual.mappings;
    plugin.run = (action: Promise<unknown>) => action;
    plugin.attachTarget = (path: string) => attachmentTarget(actual.follower.status, actual.follower.lastState, path);
    const actions = new View({}, plugin); await actions.onOpen();
    actions.addButton.onclick({}); await new Promise(resolve => setImmediate(resolve));
    assert.equal(actual.mappings.group(a.key)?.mainNote, "A.md");
    host.active = active = "B.md";
    actions.addButton.onclick({}); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(actual.mappings.group(a.key)?.relatedNotes, ["B.md"]);
});
