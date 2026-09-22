import type { Env } from '../env';
import { cronJobs } from './registry';

/**
 * 毎分の Cron Trigger から呼ばれる。
 * 1つのジョブが落ちても他を巻き込まないよう、個別に握り潰してログに残す。
 */
export async function runCronJobs(env: Env, ctx: ExecutionContext): Promise<void> {
  const results = await Promise.allSettled(
    cronJobs.map(async (job) => {
      try {
        await job.run(env, ctx);
      } catch (error) {
        console.error(`cron job "${job.name}" failed`, error);
        throw error;
      }
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.error(`${failed}/${cronJobs.length} cron jobs failed`);
}
