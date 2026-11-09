import { test } from "node:test";
import assert from "node:assert/strict";
import { MappingStore, groupTitle, members } from "../src/mappings";
import { persistedData } from "../src/validation";
import { saveGroupMigration } from "../src/migration";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";
import type { GroupChange } from "../src/follower";

function group() {
    const store = new MappingStore();
    for (const path of ["Main.md", "First.md", "Second.md"]) store.addNote("a", path, "Budget.xlsx");
    return store;
}
test("groups: v1 migrates losslessly and v2 reload is deterministic/idempotent", () => {
    const original = { settings: { endpointFile: "", followEnabled: false }, mappings: { version: 1, mappings: {
        "url:example.com/a": { notePath: "Research.md", label: "Research page" },
        "file:id:123": { notePath: "Budget.md", label: "Budget.xlsx" },
    } } };
    const frozen = JSON.stringify(original);
    const data = persistedData(original);
    const store = new MappingStore(data.mappings);
    assert.deepEqual(store.group("file:id:123"), { mainNote: "Budget.md", relatedNotes: [], label: "Budget.xlsx", header: { mode: "context" } });
    assert.equal(store.toJSON().version, 2);
    assert.equal(JSON.stringify(original), frozen);
    assert.equal(data.settings.endpointFile, ""); assert.equal(data.settings.followEnabled, false);
    const reloaded = new MappingStore(persistedData({ mappings: store.toJSON() }).mappings);
    assert.deepEqual(reloaded.toJSON(), store.toJSON());
    assert.deepEqual(new MappingStore(reloaded.toJSON()).toJSON(), reloaded.toJSON());
});
test("groups: migration backup is ordered, never overwrites existing backup, stops on write failure", async () => {
    const files = new Map([["plugin/data-v1-backup.json", "existing"]]);
    const events: string[] = [];
    await saveGroupMigration({ old: true }, { version: 2 }, "plugin", {
        exists: async p => files.has(p), write: async (p, s) => { files.set(p, s); events.push("backup"); },
        save: async () => { events.push("save"); assert.ok(files.has("plugin/data-v1-backup-1.json")); },
    });
    assert.deepEqual(events, ["backup", "save"]); assert.equal(files.get("plugin/data-v1-backup.json"), "existing");
    assert.deepEqual(JSON.parse(files.get("plugin/data-v1-backup-1.json")!), { old: true });
    await assert.rejects(saveGroupMigration({}, {}, "plugin", { exists: async () => false,
        write: async () => { throw new Error("read only"); }, save: async () => assert.fail("must not save") }));
});
test("groups: first note is Main, additions are ordered Related, duplicate membership is a no-op", () => {
    const store = new MappingStore();
    assert.equal(store.addNote("a", "Main.md", "A"), true);
    assert.deepEqual(store.group("a")?.relatedNotes, []);
    assert.equal(store.addNote("a", "Related.md", "A"), true);
    const before = store.toJSON();
    assert.equal(store.addNote("a", "Related.md", "A"), false);
    assert.equal(store.addNote("a", "Main.md", "A"), false);
    assert.deepEqual(store.toJSON(), before);
    assert.deepEqual(members(store.group("a")!), ["Main.md", "Related.md"]);
});
test("groups: Make Main and Set Main retain old Main first and all remaining memberships", () => {
    const store = group();
    assert.equal(store.makeMain("a", "Second.md"), true);
    assert.deepEqual(members(store.group("a")!), ["Second.md", "Main.md", "First.md"]);
    store.attach("a", "New.md", "Budget.xlsx");
    assert.deepEqual(members(store.group("a")!), ["New.md", "Second.md", "Main.md", "First.md"]);
    assert.equal(store.makeMain("a", "Missing.md"), false);
});
test("groups: Related drop onto Main promotes, Related drops reorder in both directions", () => {
    const store = group();
    assert.equal(store.dropNote("a", "First.md", "Second.md"), true);
    assert.deepEqual(store.group("a")?.relatedNotes, ["Second.md", "First.md"]);
    assert.equal(store.dropNote("a", "First.md", "Second.md"), true);
    assert.deepEqual(store.group("a")?.relatedNotes, ["First.md", "Second.md"]);
    assert.equal(store.dropNote("a", "Second.md", "Main.md"), true);
    assert.deepEqual(members(store.group("a")!), ["Second.md", "Main.md", "First.md"]);
    assert.equal(store.dropNote("a", "Second.md", "First.md"), false); // Main cannot be dragged
    assert.equal(store.dropNote("other", "Main.md", "First.md"), false);
});
test("groups: reorder validates exact membership and keeps Main anchored", () => {
    const store = group();
    assert.equal(store.reorderRelated("a", ["Second.md", "First.md"]), true);
    assert.equal(store.group("a")?.mainNote, "Main.md");
    const before = store.toJSON();
    for (const bad of [["Main.md", "First.md"], ["First.md"], ["First.md", "First.md"], ["First.md", "Unknown.md"]]) assert.equal(store.reorderRelated("a", bad), false);
    assert.deepEqual(store.toJSON(), before);
});
test("groups: remove Related, remove Main promotes first Related, final removal deletes only group", () => {
    const store = group();
    store.removeNote("a", "First.md");
    assert.deepEqual(members(store.group("a")!), ["Main.md", "Second.md"]);
    store.removeNote("a", "Main.md"); assert.equal(store.group("a")?.mainNote, "Second.md");
    store.removeNote("a", "Second.md"); assert.equal(store.group("a"), undefined);
});
test("groups: vault rename/move preserves role and order; deleting Main promotes deterministically", () => {
    const store = group();
    store.renameNote("Main.md", "Folder/Renamed.md");
    store.renameNote("First.md", "Folder/Related.md");
    store.renameNote("Folder", "Moved");
    assert.deepEqual(members(store.group("a")!), ["Moved/Renamed.md", "Moved/Related.md", "Second.md"]);
    store.deleteNote("Moved/Renamed.md");
    assert.equal(store.group("a")?.mainNote, "Moved/Related.md");
    store.deleteNote("Moved"); assert.equal(store.group("a")?.mainNote, "Second.md");
    store.deleteNote("Second.md"); assert.equal(store.group("a"), undefined);
});
test("groups: context/custom/hidden headers change metadata only and survive reload", () => {
    const store = group();
    assert.equal(groupTitle(store.group("a")!), "Budget.xlsx");
    store.setHeader("a", { mode: "custom", label: "  Project  " });
    assert.equal(groupTitle(store.group("a")!), "Project");
    store.setHeader("a", { mode: "hidden" }); assert.equal(groupTitle(store.group("a")!), null);
    const reload = new MappingStore(persistedData({ mappings: store.toJSON() }).mappings);
    assert.equal(groupTitle(reload.group("a")!), null);
    reload.setHeader("a", { mode: "context" }); assert.equal(groupTitle(reload.group("a")!), "Budget.xlsx");
    assert.deepEqual(members(reload.group("a")!), ["Main.md", "First.md", "Second.md"]);
    assert.equal(reload.setHeader("a", { mode: "custom", label: " " }), false);
});
test("groups: same note can belong to independent groups and rename updates both", () => {
    const store = group(); store.addNote("b", "Other.md", "B"); store.addNote("b", "First.md", "B");
    assert.deepEqual(store.keysForNote("First.md"), ["a", "b"]);
    store.renameNote("First.md", "Shared.md");
    assert.deepEqual(store.keysForNote("Shared.md"), ["a", "b"]);
    store.removeNote("a", "Shared.md"); assert.deepEqual(store.keysForNote("Shared.md"), ["b"]);
});
test("groups: specific Undo restores complete membership, order and header after reload", () => {
    const store = group(); store.setHeader("a", { mode: "custom", label: "Project" });
    store.reorderRelated("a", ["Second.md", "First.md"]);
    const before = store.group("a"); store.detach("a");
    const reload = new MappingStore(store.toJSON());
    assert.equal(reload.undo(reload.recent()[0].id, () => true), true);
    assert.deepEqual(reload.group("a"), before);
    reload.makeMain("a", "First.md");
    assert.equal(reload.undo(reload.recent()[0].id, p => p !== "Second.md"), false);
});
test("groups: corrupt v2 groups reject instead of silently losing members", () => {
    const valid = group().toJSON();
    for (const patch of [{ relatedNotes: ["First.md", "First.md"] }, { relatedNotes: ["Main.md"] },
        { mainNote: "../bad.md" }, { header: { mode: "other" } }, { relatedNotes: ["a.png"] }]) {
        assert.throws(() => persistedData({ mappings: { ...valid, groups: { a: { ...valid.groups.a, ...patch } } } }));
    }
});
test("groups: A to B to A opens Main; reading Related does not change Main or fight manual reading", async () => {
    const service = new FakeService(), host = new FakeHost();
    const { follower, mappings } = makeFollower(service, host);
    host.files = new Set(["Main.md", "Related.md", "Other.md"]);
    const a = snapshot("notepad.exe", "A", "C:/A.txt"), b = snapshot("notepad.exe", "B", "C:/B.txt");
    mappings.attach(a.key, "Main.md", "A"); mappings.addNote(a.key, "Related.md", "A"); mappings.attach(b.key, "Other.md", "B");
    service.set(a); await follower.step();
    await follower.openSavedNote("Related.md"); service.set(a); await follower.step();
    assert.equal(host.active, "Related.md"); assert.equal(mappings.group(a.key)?.mainNote, "Main.md");
    service.set(b); await follower.step(); service.set(a); await follower.step();
    assert.deepEqual(host.opened, ["Main.md", "Related.md", "Other.md", "Main.md"]);
});
test("groups: all user mutations fetch fresh privacy state, reject stale lastExternal and recover", async () => {
    const service = new FakeService(), host = new FakeHost(); host.files = new Set(["Main.md", "First.md", "Second.md", "New.md"]); host.active = "New.md";
    const a = snapshot("chrome.exe", "Page"); a.key = "url:example.com/a";
    const { follower, mappings } = makeFollower(service, host);
    service.set(a); await follower.step();
    for (const path of ["Main.md", "First.md", "Second.md"]) mappings.addNote(a.key, path, "Page");
    const before = mappings.toJSON();
    // Relationship changes wait for a verified browser privacy state; display-only changes (reorder, header) never do (see sidebar-0171).
    const changes: GroupChange[] = [{ kind: "main", path: "First.md" }, { kind: "remove", path: "Main.md" },
        { kind: "drop", path: "First.md", onto: "Main.md" }, { kind: "detach" }, { kind: "add", path: "New.md" },
        { kind: "insert", path: "New.md" }];
    for (const detail of ["confirmed-private", "verifying-context"] as const) {
        service.state = { seq: service.state.seq + 1, current: null, lastExternal: a, pauseReason: "private-browsing", pauseDetail: detail };
        assert.equal((await follower.attachCurrentNote()).ok, false);
        assert.equal((await follower.addCurrentNote()).ok, false);
        assert.equal((await follower.removeCurrentNote()).ok, false);
        assert.equal((await follower.detachCurrentContext()).ok, false);
        for (const change of changes) assert.equal((await follower.changeGroup(a.key, change)).ok, false);
        assert.deepEqual(mappings.toJSON(), before);
    }
    service.set(a); assert.equal((await follower.addCurrentNote()).ok, true);
    assert.deepEqual(mappings.group(a.key)?.relatedNotes, ["First.md", "Second.md", "New.md"]);
});
test("groups: URL identity remains cross-browser, same-title URLs separate, reload retains Main and order", async () => {
    const service = new FakeService(), host = new FakeHost(); host.files = new Set(["A.md", "B.md", "Notes.md"]);
    const a = { ...snapshot("chrome.exe", "Same title"), key: "url:example.com/a" };
    const b = { ...a, key: "url:example.com/b" };
    const store = new MappingStore(); store.addNote(a.key, "A.md", "Page A"); store.addNote(a.key, "Notes.md", "Page A"); store.addNote(b.key, "B.md", "Page B");
    store.setHeader(a.key, { mode: "custom", label: "Research" });
    const { follower, mappings } = makeFollower(service, host, { mappings: new MappingStore(store.toJSON()) });
    service.set(a); await follower.step(); service.set(b); await follower.step();
    service.set({ ...a, process: "msedge.exe" }); await follower.step();
    assert.deepEqual(host.opened, ["A.md", "B.md", "A.md"]);
    assert.deepEqual(mappings.group(a.key), { ...store.group(a.key), navigation: { kind: "page", url: "https://example.com/a" } });
});
