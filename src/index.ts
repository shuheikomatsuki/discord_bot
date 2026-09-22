import { runCronJobs } from './core/cron';
import app from './core/http';
import type { Env } from './env';

export default {
  fetch: app.fetch,
  scheduled: async (_event, env, ctx) => {
    await runCronJobs(env, ctx);
  },
} satisfies ExportedHandler<Env>;
