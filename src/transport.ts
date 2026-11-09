import { get, request as httpRequest } from "node:http";
import type { HttpGet } from "./client";

/** Desktop-only transport: no proxy, redirects or DNS; bounded even if the peer stalls. */
export const loopbackGet: HttpGet = (url, headers, signal) => new Promise((resolve, reject) => {
    const address = new URL(url);
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.username || address.password) {
        reject(new Error("Only local companion requests are allowed.")); return;
    }
    const request = get(address, { headers, signal, agent: false }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1048576) request.destroy(new Error("Context response exceeds the size limit."));
            else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Companion request timed out.")), 35000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
});

export type HttpRequest = (method: "GET" | "POST", url: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; text: string }>;

/** Local companion only (127.0.0.1), small bodies both ways, no redirects or proxies. Used for license calls. */
export const loopbackRequest: HttpRequest = (method, url, headers, body) => new Promise((resolve, reject) => {
    const address = new URL(url);
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.username || address.password) {
        reject(new Error("Only local companion requests are allowed.")); return;
    }
    const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
    const request = httpRequest(address, { method, agent: false, headers: { ...headers, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}) } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) request.destroy(new Error("Response too large.")); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Companion request timed out.")), 25000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
    request.end(payload);
});
