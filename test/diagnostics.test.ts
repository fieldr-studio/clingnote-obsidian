import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startContextDiagnostics, traceContext, flushContextDiagnostics } from "../src/diagnostics";
import type { ContextState } from "../src/types";

test("diagnostic file preserves order and correlates keys without raw values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clingnote-trace-"));
    try {
        const file = join(dir, "nested", "trace.log");
        startContextDiagnostics(file);
        const current = { key: "url:secret.example/page", title: "PRIVATE TEST TITLE", path: null,
            type: "window", process: "chrome.exe", pathSource: "None", hwnd: 1, pid: 1 } as const;
        const state: ContextState = { seq: 42, current, lastExternal: current, pauseReason: null };
        traceContext("note-open-start", state, { mappingKey: current.key });
        traceContext("status-render", state, { statusKey: current.key });
        await flushContextDiagnostics();
        const text = await readFile(file, "utf8");
        assert.ok(!text.includes(current.key) && !text.includes(current.title));
        const records = text.trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(records.map(r => r.event), ["trace-start", "note-open-start", "status-render"]);
        assert.equal(records[1].mappingKey, records[2].statusKey);
        assert.equal(records[2].title, records[2].statusTitle);
        assert.equal(records[2].seq, 42);
        assert.equal(records[2].current, records[2].lastExternal);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
