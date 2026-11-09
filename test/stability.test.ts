import test from "node:test";
import assert from "node:assert/strict";
import { FakeHost, FakeService, makeFollower, snapshot } from "./helpers";
import { contextAccess, attachmentTarget } from "../src/context-policy";
import { compactStatus } from "../src/presentation";
import { contextState } from "../src/validation";
import type { ContextSnapshot, ContextState } from "../src/types";

function state(seq: number, accepted: ContextSnapshot | null, availability: NonNullable<ContextState["availability"]>): ContextState {
    const blocked = !["ready", "none"].includes(availability);
    return { seq, acceptedTarget: availability === "private" ? null : accepted, availability,
        current: availability === "ready" ? accepted : null, lastExternal: availability === "private" ? null : accepted,
        pauseReason: blocked ? "private-browsing" : null,
        pauseDetail: blocked ? availability === "private" ? "confirmed-private" : "verifying-context" : null };
}
const a = { ...snapshot("chrome.exe", "A"), key: "url:example.test/a" };
const b = { ...a, key: "url:example.test/b", title: "B" };
const c = { ...a, key: "url:example.test/c", title: "C" };

test("accepted target: availability preserves A, blocks stale attach, recovery does not reopen Main", async () => {
    const service = new FakeService(), host = new FakeHost();
    host.files = new Set(["Main.md", "Reading.md", "B.md"]);
    const { follower, mappings } = makeFollower(service, host);
    mappings.attach(a.key, "Main.md", "A"); mappings.attach(b.key, "B.md", "B");
    service.state = state(1, a, "ready"); await follower.step();
    assert.deepEqual(host.opened, ["Main.md"]);
    host.active = "Reading.md"; // Obsidian note selection is not an external transition
    await follower.step();
    assert.equal(attachmentTarget(follower.status, follower.lastState, host.active)?.key, a.key);
    assert.equal(contextAccess(follower.status, follower.lastState).accepted?.key, a.key);
    for (const unavailable of ["privacy-unknown", "identity-unavailable"] as const) {
        service.state = state(service.state.seq + 1, a, unavailable); await follower.step();
        assert.ok(contextState(service.state));
        assert.equal(follower.lastState?.acceptedTarget?.key, a.key);
        assert.equal(attachmentTarget(follower.status, follower.lastState, host.active), null);
        assert.equal((await follower.attachCurrentNote()).ok, false);
        assert.equal(compactStatus(follower.status, follower.lastState, true, true), "ClingNote: Context unavailable");
        await follower.step(); // notes foreground, unchanged observation
        service.state = state(service.state.seq + 1, a, "ready"); await follower.step();
        assert.deepEqual(host.opened, ["Main.md"], "uncertainty clearing must not interrupt manual reading");
        assert.equal(host.active, "Reading.md");
    }
    service.state = state(10, null, "private"); await follower.step();
    assert.equal((await follower.addCurrentNote()).ok, false);
    assert.equal(contextAccess(follower.status, follower.lastState).accepted, null);
    assert.match(compactStatus(follower.status, follower.lastState, true, true), /Private browsing/);
    service.state = state(11, b, "ready"); await follower.step();
    service.state = state(12, a, "ready"); await follower.step();
    assert.deepEqual(host.opened, ["Main.md", "B.md", "Main.md"]);
    service.state = state(13, null, "none"); await follower.step();
    assert.equal(compactStatus(follower.status, follower.lastState, true, true), "ClingNote: No context");
    assert.equal(attachmentTarget(follower.status, follower.lastState, "Reading.md"), null);
    assert.equal((await follower.attachCurrentNote()).ok, false);
});

test("three Related notes and three contexts: attachment remains eligible, Main and memberships persist", async () => {
    const service = new FakeService(), host = new FakeHost();
    const { follower, mappings } = makeFollower(service, host);
    let seq = 0;
    for (const context of [a, b, c]) {
        service.state = state(++seq, context, "ready"); await follower.step();
        const main = `${context.title}-Main.md`; host.files.add(main); host.active = main;
        assert.equal((await follower.attachCurrentNote()).ok, true);
        for (let i = 1; i <= 3; i++) {
            host.active = `${context.title}-Related${i}.md`; host.files.add(host.active);
            await follower.step(); // same external target while selecting another Obsidian note
            assert.equal(attachmentTarget(follower.status, follower.lastState, host.active)?.key, context.key);
            assert.equal((await follower.addCurrentNote()).ok, true, `attach Related ${i} to ${context.title}`);
            assert.equal(follower.lastState?.acceptedTarget?.key, context.key);
        }
        assert.equal(mappings.group(context.key)?.relatedNotes.length, 3);
    }
    assert.equal((await follower.changeGroup(a.key, { kind: "main", path: "A-Related3.md" })).ok, true);
    assert.deepEqual(new Set([mappings.group(a.key)!.mainNote, ...mappings.group(a.key)!.relatedNotes]),
        new Set(["A-Main.md", "A-Related1.md", "A-Related2.md", "A-Related3.md"]));
    host.opened = [];
    for (const context of [a, b, c, a]) { service.state = state(++seq, context, "ready"); await follower.step(); }
    assert.deepEqual(host.opened, ["A-Related3.md", "B-Main.md", "C-Main.md", "A-Related3.md"]);
});

test("new contract rejects unsafe contradictions; legacy no-current cannot secretly attach lastExternal", () => {
    assert.equal(contextState({ ...state(1, a, "private"), acceptedTarget: a }), false);
    assert.equal(contextState({ ...state(1, a, "ready"), pauseReason: "private-browsing" }), false);
    const legacy = { seq: 1, current: null, lastExternal: a, pauseReason: null };
    assert.equal(contextAccess("connected", legacy).target, null);
    assert.equal(compactStatus("connected", legacy, true, true), "ClingNote: No context");
    assert.equal(attachmentTarget("connected", state(1, a, "ready"), "image.png"), null);
    assert.equal(attachmentTarget("disconnected", state(1, a, "ready"), "Note.md"), null);
});
