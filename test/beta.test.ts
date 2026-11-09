import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextClient } from "../src/client";
import { ContextFollower } from "../src/follower";
import { MappingStore } from "../src/mappings";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";

test("privacy blocks following, attach and detach; same-key recovery preserves manual reading", async () => {
    const service = new FakeService();
    const host = new FakeHost(); host.files.add("a.md"); host.active = "a.md";
    const { follower, mappings } = makeFollower(service, host);
    const page = { ...snapshot("chrome.exe", "Page"), key: "url:example.com/a" };
    service.set(page);
    assert.equal((await follower.attachCurrentNote()).ok, true);
    service.state = { seq: 2, current: null, lastExternal: page, pauseReason: "private-browsing" };
    host.active = "other.md";
    await follower.step();
    assert.equal(host.opened.length, 0);
    assert.equal((await follower.attachCurrentNote()).ok, false);
    assert.equal((await follower.detachCurrentContext()).ok, false);
    assert.equal(mappings.entries().length, 1);
    assert.match(follower.statusText(), /private browsing/);
    service.set(page);
    await follower.step();
    assert.deepEqual(host.opened, [], "privacy outcome alone is not a new accepted context");
});

test("manual pause stays separate and resume fetches fresh privacy state", async () => {
    const service = new FakeService(); const host = new FakeHost();
    host.files.add("a.md"); host.active = "other.md";
    let following = true;
    const { follower, mappings } = makeFollower(service, host, { follow: () => following });
    const page = snapshot("chrome.exe", "Page");
    mappings.attach(page.key, "a.md", "A"); service.set(page); await follower.step();
    host.opened.length = 0; following = false;
    service.state = { ...service.state, current: null, pauseReason: "private-browsing", seq: 2 };
    following = true; await follower.refresh();
    assert.equal(host.opened.length, 0, "refresh must not apply cached normal state");
    following = false; service.set(page); await follower.step();
    assert.equal(host.opened.length, 0);
    assert.match(follower.statusText(), /paused/);
});

test("note-open failure does not kill following and retries the same key", async () => {
    const service = new FakeService(); const host = new FakeHost(); host.files.add("a.md");
    const { follower, mappings } = makeFollower(service, host);
    const page = snapshot("excel.exe", "A"); mappings.attach(page.key, "a.md", "A"); service.set(page);
    const open = host.openNote; let fails = true;
    host.openNote = async path => { if (fails) throw new Error("vault temporarily busy"); await open(path); };
    assert.equal(await follower.step(), true);
    assert.equal(host.notices.length, 1);
    await follower.step(); assert.equal(host.notices.length, 1, "no notification spam");
    fails = false; await follower.step(); assert.equal(host.active, "a.md");
});

test("folder rename, note deletion and non-Markdown attachments are deterministic", async () => {
    const mappings = new MappingStore();
    mappings.attach("a", "folder/a.md", "A"); mappings.attach("b", "folder/nested/b.md", "B");
    mappings.attach("c", "folderish/c.md", "C");
    assert.equal(mappings.renameNote("folder", "moved"), 2);
    assert.equal(mappings.get("b")?.notePath, "moved/nested/b.md");
    assert.equal(mappings.deleteNote("moved"), 2);
    assert.equal(mappings.get("c")?.notePath, "folderish/c.md");
    mappings.renameNote("folderish/c.md", "folderish/c.pdf"); assert.equal(mappings.entries().length, 0);
    const service = new FakeService(); const host = new FakeHost(); host.active = "image.png";
    service.set(snapshot("excel.exe", "A"));
    assert.equal((await makeFollower(service, host).follower.attachCurrentNote()).ok, false);
});

test("connection change drops old poll and switches endpoint immediately", async () => {
    const host = new FakeHost(); host.files.add("old.md").add("new.md");
    const mappings = new MappingStore(); mappings.attach("old", "old.md", "old"); mappings.attach("new", "new.md", "new");
    let port = 1;
    let release!: (response: { status: number; text: string }) => void;
    const state = (key: string) => JSON.stringify({ seq: 1, current: { ...snapshot("excel.exe", key), key }, lastExternal: null, pauseReason: null });
    const client = new ContextClient(async () => ({ port, token: "t" }), async url => {
        if (url.includes(":1/")) return new Promise(resolve => { release = resolve; });
        return { status: 200, text: state("new") };
    });
    const follower = new ContextFollower(client, mappings, host, () => true);
    const pending = follower.step();
    await new Promise(resolve => setImmediate(resolve));
    port = 2; await follower.reconnect();
    release({ status: 200, text: state("old") }); await pending;
    assert.deepEqual(host.opened, ["new.md"]);
});

test("old service without pause contract fails safely", async () => {
    const client = new ContextClient(async () => ({ port: 1, token: "t" }), async () => ({ status: 200, text: '{"seq":1,"current":null,"lastExternal":null}' }));
    await assert.rejects(client.getState(), /Incompatible/);
});

test("late normal poll cannot override a newer privacy response", async () => {
    const host = new FakeHost(); host.files.add("a.md"); host.active = "a.md";
    const mappings = new MappingStore(); mappings.attach("page", "a.md", "A");
    const normal = { seq: 1, current: { ...snapshot("chrome.exe", "A"), key: "page" }, lastExternal: null, pauseReason: null };
    let release!: (value: { status: number; text: string }) => void;
    let calls = 0;
    const client = new ContextClient(async () => ({ port: 1, token: "t" }), async () => {
        calls++;
        if (calls === 1) return new Promise(resolve => { release = resolve; });
        return { status: 200, text: JSON.stringify({ ...normal, seq: 2, current: null, pauseReason: "private-browsing" }) };
    });
    const follower = new ContextFollower(client, mappings, host, () => true);
    const poll = follower.step(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await follower.attachCurrentNote()).ok, false);
    host.active = "other.md";
    release({ status: 200, text: JSON.stringify(normal) }); await poll;
    assert.equal(host.opened.length, 0);
    assert.equal(follower.lastState?.pauseReason, "private-browsing");
});

test("reloaded plugin follows persisted mappings", async () => {
    const service = new FakeService(); const host = new FakeHost(); host.files.add("a.md");
    const state = snapshot("excel.exe", "A"); service.set(state);
    const store = new MappingStore(); store.attach(state.key, "a.md", "A");
    const copy = new MappingStore(JSON.parse(JSON.stringify(store.toJSON())));
    await makeFollower(service, host, { mappings: copy }).follower.step();
    assert.equal(host.active, "a.md");
});

test("command reconnect cannot reuse a high-sequence pre-restart context during privacy pause", async () => {
    const service = new FakeService(); const host = new FakeHost(); host.files.add("a.md"); host.active = "a.md";
    const { follower, mappings } = makeFollower(service, host);
    service.set(snapshot("excel.exe", "Old")); service.state.seq = 100;
    await follower.step();
    service.failing = true;
    assert.equal((await follower.attachCurrentNote()).ok, false);
    service.failing = false;
    service.state = { seq: 1, current: null, lastExternal: null, pauseReason: "private-browsing" };
    assert.equal((await follower.attachCurrentNote()).ok, false);
    assert.equal(mappings.entries().length, 0);
    assert.equal(follower.lastState?.pauseReason, "private-browsing");
});
