import { ApplicationCommandType } from 'discord-api-types/v10';
import { ephemeralText } from '../../core/respond';
import type { Feature } from '../../core/types';

/** 新しい feature を書くときの最小のお手本 */
const feature: Feature = {
  name: 'ping',
  commands: [
    {
      definition: {
        name: 'ping',
        description: 'Bot が生きているか確認する',
        type: ApplicationCommandType.ChatInput,
      },
      handler: async () => ephemeralText('pong 🏓'),
    },
  ],
};

export default feature;
