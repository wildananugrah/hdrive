import { sql } from "../src/db.ts";
import { register } from "../src/auth.ts";

const [email, password, name] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: bun run seed:admin <email> <password> [name]");
  process.exit(1);
}

const [existing] = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
const id = existing?.id ?? (await register(email, password, name ?? "Admin")).id;
await sql`UPDATE users SET is_admin = true WHERE id = ${id}`;
console.log(`admin ready: ${email}`);
await sql.close();
