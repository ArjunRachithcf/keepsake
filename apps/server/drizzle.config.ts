import { defineConfig } from 'drizzle-kit';

// Migrations come from `pnpm db:generate` after a change to src/db/schema.ts (test/migrations.contract.test.ts checks
// they agree, and that a released migration never changes).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
