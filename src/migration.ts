/** Backup before the first v2 save. Caller validates data and stops loading on any failure. */
export async function saveGroupMigration(original: unknown, next: unknown, directory: string, io: {
    exists(path: string): Promise<boolean>;
    write(path: string, contents: string): Promise<void>;
    save(data: unknown): Promise<void>;
}): Promise<void> {
    let backup = `${directory}/data-v1-backup.json`;
    for (let n = 1; await io.exists(backup); n++) backup = `${directory}/data-v1-backup-${n}.json`;
    await io.write(backup, JSON.stringify(original, null, 2));
    await io.save(next);
}
