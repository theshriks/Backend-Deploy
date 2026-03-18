import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

type Env = {
  DIRECT_URL: string;
};

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env<Env>('DIRECT_URL'),
  },
});
