import test from "node:test";
import assert from "node:assert/strict";
import { discoverEndpoint } from "../src/discovery";
import { ConnectionError, ContextClient } from "../src/client";
const absent = () => Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
test("default discovery distinguishes absent install and installed but stopped without launching anything", async () => {
    await assert.rejects(discoverEndpoint("", "C:\\Profile", absent), e => e instanceof ConnectionError && e.reason === "missing");
    const receipt = JSON.stringify({ product: "ClingNote.Obsidian.Companion", formatVersion: 1 });
    await assert.rejects(discoverEndpoint("", "C:\\Profile", path => path.endsWith("installation.json") ? Promise.resolve(receipt) : absent()),
        e => e instanceof ConnectionError && e.reason === "installed");
    assert.equal(await discoverEndpoint("C:\\Dev\\endpoint.json", "C:\\Profile", absent), null);
    await assert.rejects(discoverEndpoint("", "C:\\Profile", async () => "invalid JSON"), /unavailable or invalid/);
});
test("default endpoint takes precedence over receipt and client rediscovers rotated token after failure", async () => {
    let token = "first", reads = 0, fail = false;
    const read = async (path: string) => {
        reads++; assert.equal(path, "C:\\Profile\\ClingNote.Context\\endpoint.json");
        return JSON.stringify({ port: 1234, token, protocolMajor: 1 });
    };
    const client = new ContextClient(() => discoverEndpoint("", "C:\\Profile", read), async (_url, headers) => {
        if (fail) return { status: 401, text: "" };
        assert.equal(headers.Authorization, `Bearer ${token}`);
        return { status: 200, text: JSON.stringify({ seq: 0, current: null, lastExternal: null, pauseReason: null }) };
    });
    await client.getState(); fail = true; await assert.rejects(client.getState());
    token = "second"; fail = false; await client.getState(); assert.equal(reads, 2);
});
