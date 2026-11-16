import { db } from "../src/platform/db/index.js";
import { admins } from "../src/platform/db/schema/staff.js";

const [clerkUserId, email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ");

if (!clerkUserId || !email || !name) {
    console.error('Usage: tsx scripts/seed-super-admin.ts <clerkUserId> <email> "<full name>"');
    process.exit(1);
}

const inserted = await db
    .insert(admins)
    .values({ clerkUserId, email, name, role: "super_admin" })
    .onConflictDoNothing()
    .returning({ id: admins.id });

console.log(inserted.length ? `Super admin created: ${inserted[0].id}` : "Already exists, nothing changed.");
process.exit(0);