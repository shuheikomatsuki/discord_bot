import type { Feature } from '../../core/types';
import { components, modals } from './components';
import { closeStaleCheckins, promptDueHabits, remindUnanswered, sendSummaries } from './cron';
import { goalCommand } from './goalCommand';
import { habitCommand } from './habitCommand';
import { FEATURE_NAME } from './service';
import { statsCommand } from './statsCommand';

/** 習慣化・目標達成・振り返り・ゲーミフィケーション（docs/HABIT.md） */
const feature: Feature = {
  name: FEATURE_NAME,
  commands: [habitCommand, goalCommand, statsCommand],
  components,
  modals,
  cron: [
    // 3つは並列に走る。close は前日以前、prompt は当日の行しか触らないので競合しない
    { name: 'habit:close', run: (env) => closeStaleCheckins(env) },
    { name: 'habit:prompt', run: (env) => promptDueHabits(env) },
    { name: 'habit:summary', run: (env) => sendSummaries(env) },
    // 当日の pending だけを触る。回答と競合しても claim の条件（status = 'pending'）で弾かれる
    { name: 'habit:remind', run: (env) => remindUnanswered(env) },
  ],
};

export default feature;
