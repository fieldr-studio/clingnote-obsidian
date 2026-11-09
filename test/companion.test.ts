import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ContextClient } from "../src/client";
import { loopbackGet } from "../src/transport";
import { ContextFollower } from "../src/follower";
import { MappingStore } from "../src/mappings";
import { FakeHost } from "./helpers";

const state = { seq: 0, current: null, lastExternal: null, pauseReason: null };
test("protocol advertisement accepts legacy/major 1 and rejects unknown major before HTTP", async () => {
    for (const major of [undefined, 1, 2, "1", null]) {
        let calls = 0;
        const client = new ContextClient(async () => ({ port: 1, token: "t", protocolMajor: major as number }), async () => {
            calls++; return { status: 200, text: JSON.stringify(state) };
        });
        if (major === undefined || major === 1) { assert.deepEqual(await client.getState(), state); assert.equal(calls, 1); }
        else { await assert.rejects(client.getState(), /Incompatible companion protocol/); assert.equal(calls, 0); }
    }
});

test("stalled verification HTTP request reaches disconnected at the existing deadline and can retry", { timeout: 45000 }, async () => {
    let respond = false;
    const server = createServer((_req, res) => { if (respond) res.end(JSON.stringify(state)); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const follower = new ContextFollower(new ContextClient(async () => ({ port, token: "t" }), loopbackGet),
        new MappingStore(), new FakeHost(), () => true);
    try {
        assert.equal(await follower.confirmNormalContext(), false);
        assert.equal(follower.status, "disconnected");
        assert.equal(follower.lastState, null);
        respond = true;
        assert.equal(await follower.confirmNormalContext(), false, "successful empty response has no attach target");
        assert.equal(follower.status, "connected");
        assert.deepEqual(follower.lastState, state);
    } finally { follower.stop(); server.closeAllConnections(); server.close(); await once(server, "close"); }
});

test("real loopback transport cancels pending requests and refuses redirects/oversized responses", async () => {
    const server = createServer((req, res) => {
        if (req.url === "/large") res.end("x".repeat(1048577));
        else if (req.url === "/redirect") { res.writeHead(302, { Location: "http://example.com" }); res.end(); }
        // /context deliberately never responds.
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const client = new ContextClient(async () => ({ port, token: "t" }), loopbackGet);
        const pending = client.getState();
        const rejected = assert.rejects(pending, /aborted/i);
        await new Promise(resolve => setTimeout(resolve, 30));
        client.invalidate(); await rejected;
        await assert.rejects(loopbackGet(`http://127.0.0.1:${port}/large`, {}), /size limit/);
        assert.equal((await loopbackGet(`http://127.0.0.1:${port}/redirect`, {})).status, 302);
        await assert.rejects(loopbackGet("http://example.com/context", {}), /Only local/);
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});
