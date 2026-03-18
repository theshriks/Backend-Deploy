import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

type Env = {
  DIRECT_URL: string;
};

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    // Use direct connection (port 5432) — NOT the PgBouncer pooler (port 6543)
    // Prisma has its own built-in connection pool, so PgBouncer is unnecessary
    // for a long-running Express server and it blocks DDL migrations
    url: env<Env>('DIRECT_URL'),
  },
});
