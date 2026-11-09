import test from "node:test";
import assert from "node:assert/strict";
import { StatusPresentation, STATUS_GRACE_MS } from "../src/status-presentation";
import { attachmentTarget } from "../src/context-policy";
import { compactStatus } from "../src/presentation";
import { snapshot } from "./helpers";
import type { ContextState } from "../src/types";
const a = { ...snapshot("chrome.exe", "A"), key: "url:example.test/a" };
const ready: ContextState = { seq: 1, current: a, lastExternal: a, acceptedTarget: a, availability: "ready", pauseReason: null };
const unavailable: ContextState = { ...ready, seq: 2, current: null, availability: "privacy-unknown", pauseReason: "private-browsing", pauseDetail: "verifying-context" };

test("short same-key unavailable observations retain visible status only; eligibility blocks immediately", () => {
    const ui = new StatusPresentation();
    ui.read("connected", ready, true, true, true, 0);
    const before = JSON.stringify(unavailable);
    assert.equal(ui.read("connected", unavailable, true, true, true, 10).text, "ClingNote: Following");
    assert.equal(attachmentTarget("connected", unavailable, "A.md"), null);
    assert.equal(compactStatus("connected", unavailable, true, true), "ClingNote: Context unavailable");
    assert.equal(ui.read("connected", { ...unavailable, seq: 3 }, true, true, true, 1000).refreshAfterMs, 510);
    assert.equal(ui.read("connected", { ...ready, seq: 4 }, true, true, true, 1200).text, "ClingNote: Following");
    assert.equal(JSON.stringify(unavailable), before);
});

test("sustained outage expires on the one-shot deadline even without another response; repeats cannot extend grace", () => {
    const ui = new StatusPresentation();
    ui.read("connected", ready, true, true, true, 0);
    const first = ui.read("connected", unavailable, true, true, true, 100);
    assert.equal(first.refreshAfterMs, STATUS_GRACE_MS);
    const later = ui.read("connected", { ...unavailable, availability: "identity-unavailable" }, true, true, true, 1000);
    assert.equal(later.refreshAfterMs, 600);
    const expired = ui.read("connected", unavailable, true, true, true, 100 + first.refreshAfterMs!);
    assert.deepEqual(expired, { text: "ClingNote: Context unavailable" });
    assert.equal(ui.read("connected", unavailable, true, true, true, 9000).refreshAfterMs, undefined);
});

test("private, disconnect, no accepted target and changed key bypass grace; restart cannot borrow prior confirmation", () => {
    for (const [status, state, expected] of [
        ["connected", { ...unavailable, availability: "private", acceptedTarget: null, pauseDetail: "confirmed-private" }, "ClingNote: Private browsing"],
        ["disconnected", unavailable, "ClingNote: Disconnected"],
        ["connecting", unavailable, "ClingNote: Connecting…"],
        ["connected", { ...ready, seq: 3, current: null, acceptedTarget: null, availability: "none" }, "ClingNote: No context"],
        ["connected", { ...unavailable, acceptedTarget: { ...a, key: "url:example.test/b" } }, "ClingNote: Context unavailable"],
        ["connected", { ...unavailable, acceptedTarget: null }, "ClingNote: Context unavailable"],
    ] as const) {
        const ui = new StatusPresentation(); ui.read("connected", ready, true, true, true, 0);
        ui.read("connected", unavailable, true, true, true, 1);
        assert.deepEqual(ui.read(status, state, true, true, true, 2), { text: expected });
        assert.equal(ui.read("connected", unavailable, true, true, true, 3).text, "ClingNote: Context unavailable");
    }
    const ui = new StatusPresentation();
    assert.equal(ui.read("connected", unavailable, true, true, true, 0).text, "ClingNote: Context unavailable");
    ui.read("connected", { ...ready, seq: 100 }, true, true, true, 1);
    assert.equal(ui.read("connected", unavailable, true, true, true, 2).text, "ClingNote: Context unavailable");
});

test("recorded same-companion short gaps stay quiet; long gaps remain visible; pause and new ready context apply immediately", () => {
    for (const ms of [297, 454, 499, 934, 944, 967, 1454, 1919, 4000]) {
        const ui = new StatusPresentation(); ui.read("connected", ready, true, true, true, 0);
        ui.read("connected", unavailable, true, true, true, 1);
        assert.equal(ui.read("connected", unavailable, true, true, true, ms).text,
            ms < STATUS_GRACE_MS ? "ClingNote: Following" : "ClingNote: Context unavailable");
        assert.equal(ui.read("connected", { ...ready, seq: 3 }, true, true, true, ms + 1).text, "ClingNote: Following");
    }
    const ui = new StatusPresentation(); ui.read("connected", ready, true, true, true, 0);
    assert.equal(ui.read("connected", unavailable, false, true, true, 1).text, "ClingNote: Paused");
    const b = { ...a, key: "url:example.test/b" };
    assert.deepEqual(ui.read("connected", { ...ready, seq: 3, current: b, acceptedTarget: b }, true, false, true, 2), { text: "ClingNote: No note attached" });
});
