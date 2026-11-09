import test from "node:test";
import assert from "node:assert/strict";
import { ContextClient } from "../src/client";
import { MappingStore } from "../src/mappings";
import { contextState, persistedData, notePath } from "../src/validation";
import { snapshot } from "./helpers";
const good = { seq: 1, current: snapshot("chrome.exe", "Normal"), lastExternal: null, pauseReason: null };

test("malformed HTTP state fails safely instead of reaching UI/follower", async () => {
    for (const value of [null, [], {}, { ...good, seq: -1 }, { ...good, current: {} }, { ...good, current: { ...good.current, key: 3 } }, { ...good, current: { ...good.current, title: [] } }, { ...good, lastExternal: "bad" }, { ...good, pauseReason: "private-browsing" }]) {
        assert.equal(contextState(value), false);
        const client = new ContextClient(async () => ({ port: 123, token: "t" }), async () => ({ status: 200, text: JSON.stringify(value) }));
        await assert.rejects(client.getState(), /Incompatible/);
    }
    assert.ok(contextState(good));
    assert.ok(contextState({ ...good, current: null, lastExternal: good.current, pauseReason: "private-browsing" }));
});

test("production client refuses test-mode endpoint before sending its token", async () => {
    let requests = 0;
    const read = async () => ({ port: 123, token: "t", testMode: true });
    const http = async () => { requests++; return { status: 200, text: JSON.stringify(good) }; };
    await assert.rejects(new ContextClient(read, http).getState(), /test-mode/);
    assert.equal(requests, 0);
    assert.deepEqual(await new ContextClient(read, http, true).getState(), good);
});

test("oversized response and malformed endpoint token fail as connection errors", async () => {
    await assert.rejects(new ContextClient(async () => ({ port: 123, token: "t" }), async () => ({ status: 200, text: " ".repeat(1048577) })).getState(), /size limit/);
    await assert.rejects(new ContextClient(async () => ({ port: 123, token: 123 as never }), async () => { throw new Error("must not send"); }).getState(), /Invalid endpoint/);
});

test("mapping dictionary has no inherited contexts or prototype mutation", () => {
    const store = new MappingStore();
    assert.equal(store.get("constructor"), undefined);
    assert.equal(store.get("toString"), undefined);
    assert.equal(store.detach("__proto__"), false);
    store.attach("__proto__", "Note.md", "Explicit key");
    assert.equal(store.get("__proto__")?.notePath, "Note.md");
    assert.equal(store.get("notePath"), undefined);
    const copy = new MappingStore(JSON.parse(JSON.stringify(store.toJSON())));
    assert.equal(copy.get("__proto__")?.notePath, "Note.md");
    assert.equal(copy.detach("__proto__"), true);
});

test("damaged settings/mappings reject without mutation; valid existing settings survive", () => {
    for (const value of [[], "bad", { settings: { endpointFile: 3 } }, { settings: { followEnabled: "false" } }, { mappings: { version: 2, mappings: {} } }, { mappings: { version: 1, mappings: { a: { notePath: "../secret.md", label: "a" } } } }]) {
        const before = JSON.stringify(value);
        assert.throws(() => persistedData(value));
        assert.equal(JSON.stringify(value), before);
    }
    const data = { settings: { followEnabled: false, endpointFile: "C:\\Beta\\endpoint.json", showStatusBar: false }, mappings: { version: 1, mappings: { a: { notePath: "Notes/A.md", label: "A" } } } };
    const loaded = persistedData(data);
    assert.deepEqual(loaded.settings, { ...data.settings, showUnmappedHint: true });
    assert.deepEqual(loaded.mappings, data.mappings);
    assert.equal(loaded.firstRun, false);
    assert.equal(persistedData(null).firstRun, true);
});

test("mapping note paths are vault relative Markdown files", () => {
    for (const path of ["../outside.md", "/root.md", "C:/secret.md", "folder\\note.md", "folder//a.md", "image.png", "a/./b.md"]) assert.equal(notePath(path), false, path);
    assert.equal(notePath("Folder/Some note.MD"), true);
});
