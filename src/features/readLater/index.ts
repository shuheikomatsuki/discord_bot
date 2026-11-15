import { nowSeconds } from '../../core/time';
import type { Feature } from '../../core/types';
import { components } from './components';
import { loadConfig } from './config';
import { runReadLater } from './digest';
import { FEATURE_NAME } from './service';

/**
 * 「あとで読む」: 自分のチャンネルに貼った URL を毎日決まった時刻に数件ずつ紹介する。
 * スラッシュコマンドは持たないので、友人サーバーのコマンド一覧には何も増えない。
 * 詳細は docs/READ_LATER.md。
 */
const feature: Feature = {
  name: FEATURE_NAME,
  components,
  cron: [
    {
      name: 'readlater:digest',
      run: async (env) => {
        const config = loadConfig(env);
        if (!config) return;
        await runReadLater(env, config, nowSeconds());
      },
    },
  ],
};

export default feature;
