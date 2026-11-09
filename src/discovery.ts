import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { ConnectionError } from "./client";
import { endpointLocation } from "./presentation";
import type { Endpoint } from "./types";

type ReadText = (path: string) => Promise<string>;
export async function discoverEndpoint(override: string, localAppData: string | undefined,
    read: ReadText = path => readFile(path, "utf8")): Promise<Endpoint | null> {
    const path = endpointLocation(override, localAppData);
    if (!path) return null;
    try {
        const endpoint = JSON.parse(await read(path)) as Partial<Endpoint> | null;
        if (!endpoint || typeof endpoint.port !== "number" || typeof endpoint.token !== "string") throw new Error("Malformed endpoint");
        return endpoint as Endpoint; // client validates protocol, token, port, and test mode before any request
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConnectionError("Companion endpoint is unavailable or invalid.");
        if (override.trim() || !localAppData) return null;
        try {
            const receipt = JSON.parse(await read(win32.join(localAppData, "ClingNote.Context", "installation.json")));
            if (receipt?.product === "ClingNote.Obsidian.Companion" && receipt?.formatVersion === 1)
                throw new ConnectionError("Companion is installed but not running. Start it from the Start menu.", "installed");
        } catch (receiptError) {
            if (receiptError instanceof ConnectionError) throw receiptError;
            if ((receiptError as NodeJS.ErrnoException).code !== "ENOENT") throw new ConnectionError("Companion installation information is unavailable.");
        }
        throw new ConnectionError("No companion installation found. Install the Windows companion separately.", "missing");
    }
}
