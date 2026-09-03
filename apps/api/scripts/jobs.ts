import { sql } from "../src/db.ts";
import { purgeExpired, sweepPending } from "../src/trash.ts";

const retention = Number(process.env.TRASH_RETENTION_DAYS ?? 30);
const pendingHours = Number(process.env.PENDING_UPLOAD_HOURS ?? 24);

console.log(`purged ${await purgeExpired(retention)} trashed item(s)`);
console.log(`swept ${await sweepPending(pendingHours)} abandoned upload(s)`);
await sql.close();
