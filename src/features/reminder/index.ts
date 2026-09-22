import type { Feature } from '../../core/types';
import { remindCommand } from './commands';
import { components } from './components';
import { deliverDueReminders } from './cron';
import { FEATURE_NAME } from './service';

const feature: Feature = {
  name: FEATURE_NAME,
  commands: [remindCommand],
  components,
  cron: [
    {
      name: 'reminder:deliver',
      run: (env) => deliverDueReminders(env),
    },
  ],
};

export default feature;
