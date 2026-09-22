import ping from '../features/ping';
import reminder from '../features/reminder';
import type { Command, ComponentHandler, CronJob, Feature, ModalHandler } from './types';

/**
 * ★ 新機能を追加するときに触るのはこの配列だけ。
 * ここがルーティング表・コマンド登録定義・cron ジョブ一覧のすべての供給源になる。
 */
export const features: Feature[] = [ping, reminder];

/** コマンド名 -> Command */
export const commandMap: Map<string, Command> = new Map(
  features.flatMap((f) => (f.commands ?? []).map((c) => [c.definition.name, c] as const)),
);

/** "<feature>:<action>" -> ハンドラ */
export const componentMap: Map<string, ComponentHandler> = new Map(
  features.flatMap((f) =>
    Object.entries(f.components ?? {}).map(
      ([action, handler]) => [`${f.name}:${action}`, handler] as const,
    ),
  ),
);

export const modalMap: Map<string, ModalHandler> = new Map(
  features.flatMap((f) =>
    Object.entries(f.modals ?? {}).map(
      ([action, handler]) => [`${f.name}:${action}`, handler] as const,
    ),
  ),
);

export const cronJobs: CronJob[] = features.flatMap((f) => f.cron ?? []);

/** 登録スクリプトが Discord に PUT する配列 */
export const commandDefinitions = features.flatMap((f) =>
  (f.commands ?? []).map((c) => c.definition),
);
