import {
  type APIInteractionResponseCallbackData,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ComponentType,
} from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { getBoolean, getString } from '../../core/options';
import { nowSeconds } from '../../core/time';
import type { Command, CommandContext } from '../../core/types';
import { actor, ephemeral, guarded } from './context';
import { addDays, formatDateJa } from './dates';
import { BADGES, levelInfo } from './gamification';
import { levelLine } from './render';
import {
  buildReport,
  monthPeriod,
  type Period,
  periodTitle,
  previousPeriod,
  weekPeriod,
} from './report';
import * as repo from './repository';
import { FEATURE_NAME, HabitUserError, todayOf } from './service';

const definition = {
  name: 'stats',
  description: '振り返り・進捗の可視化・レベルとバッジ',
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'week',
      description: '今週（または先週）の達成状況',
      options: [
        { type: ApplicationCommandOptionType.Boolean, name: 'last', description: '先週を表示する' },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'month',
      description: '今月（または指定した月）のカレンダー',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'month',
          description: '例: 2026-10 / last（先月）',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'profile',
      description: 'レベル・XP・バッジ・フリーズ在庫',
      options: [
        {
          type: ApplicationCommandOptionType.User,
          name: 'user',
          description: '他の人のプロフィールを見る',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'ranking',
      description: 'サーバー内の XP ランキング',
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'reflections',
      description: '過去の振り返りを読む',
    },
  ],
} as const;

function reflectButton(period: Period, userId: string) {
  return [
    {
      type: ComponentType.ActionRow as const,
      components: [
        {
          type: ComponentType.Button as const,
          style: ButtonStyle.Primary as const,
          label: '振り返りを書く',
          emoji: { name: '📝' },
          custom_id: encodeCustomId(FEATURE_NAME, 'reflect', period.kind, period.key, userId),
        },
      ],
    },
  ];
}

async function report(
  c: CommandContext,
  period: Period,
): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId } = actor(c.interaction);
  const today = todayOf(c.env, nowSeconds());
  const r = await buildReport(c.env, guildId, userId, period, today);
  return ephemeral('', { embeds: [r.embed], components: reflectButton(period, userId) });
}

async function week(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { options } = actor(c.interaction);
  const today = todayOf(c.env, nowSeconds());
  const current = weekPeriod(today);
  return report(c, getBoolean(options, 'last') ? previousPeriod(current) : current);
}

async function month(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { options } = actor(c.interaction);
  const today = todayOf(c.env, nowSeconds());
  const input = getString(options, 'month')?.trim();
  if (!input) return report(c, monthPeriod(today));
  if (input === 'last' || input === '先月') return report(c, previousPeriod(monthPeriod(today)));
  const m = input.match(/^(\d{4})[-/](\d{1,2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new HabitUserError('月は `2026-10` の形で指定してください（先月なら `last`）。');
  }
  return report(c, monthPeriod(`${m[1]}-${m[2]?.padStart(2, '0')}-01`));
}

async function profile(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId: self, options } = actor(c.interaction);
  const target = options.find((o) => o.name === 'user')?.value;
  const userId = typeof target === 'string' ? target : self;
  const db = c.env.DB;
  const now = nowSeconds();

  const p =
    userId === self
      ? await repo.ensureProfile(db, guildId, userId, now)
      : await repo.getProfile(db, guildId, userId);
  if (!p) return ephemeral(`<@${userId}> さんはまだ習慣や目標を登録していません。`);

  const [habits, goalsDone, owned] = await Promise.all([
    repo.listHabits(db, guildId, userId),
    repo.countCompletedGoals(db, guildId, userId),
    repo.listBadges(db, guildId, userId),
  ]);
  const ownedSet = new Set(owned);
  const active = habits.filter((h) => h.status === 'active');
  const best = habits.reduce((m, h) => Math.max(m, h.bestStreak), 0);
  const totalDone = habits.reduce((s, h) => s + h.totalDone, 0);

  const lines = [
    `👤 <@${userId}>`,
    levelLine(levelInfo(p.xp), p.xp),
    `🧊 フリーズ ×${p.freezes} · 習慣 ${active.length}個 · 累計達成 ${totalDone}回 · 最長 ${best}日連続 · 目標達成 ${goalsDone}個`,
  ];
  if (active.length > 0) {
    lines.push('', '**連続記録**');
    for (const h of [...active].sort((a, b) => b.currentStreak - a.currentStreak).slice(0, 10)) {
      lines.push(`🔥 ${String(h.currentStreak).padStart(3)}日 ${h.name}`);
    }
  }
  lines.push('', `**バッジ（${ownedSet.size}/${BADGES.length}）**`);
  // 持っていないものも「？」で見せて、次の目標にしてもらう
  for (const b of BADGES) {
    lines.push(
      ownedSet.has(b.id)
        ? `${b.emoji} **${b.name}** — ${b.description}`
        : `🔒 ${b.name} — ${b.description}`,
    );
  }
  return ephemeral(lines.join('\n').slice(0, 2000), { allowed_mentions: { parse: [] } });
}

async function rankingView(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId } = actor(c.interaction);
  const rows = await repo.ranking(c.env.DB, guildId, 10);
  if (rows.length === 0)
    return ephemeral('まだ誰も XP を持っていません。最初の1人になりましょう！');
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((p, i) => {
    const me = p.userId === userId ? ' ← あなた' : '';
    return `${medals[i] ?? `${i + 1}.`} <@${p.userId}> Lv.${levelInfo(p.xp).level}（${p.xp}XP）${me}`;
  });
  return ephemeral(
    `🏆 **XP ランキング**\n${lines.join('\n')}\n\n-# 表示したくない場合は \`/habit settings hide_ranking:True\``,
    {
      allowed_mentions: { parse: [] },
    },
  );
}

async function reflections(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId } = actor(c.interaction);
  const rows = await repo.recentReflections(c.env.DB, guildId, userId, 6);
  if (rows.length === 0) {
    return ephemeral(
      'まだ振り返りがありません。`/stats week` のボタンや、月曜に届くまとめから書けます。',
    );
  }
  const blocks = rows.map((r) => {
    const title =
      r.period === 'week'
        ? periodTitle({
            kind: 'week',
            key: r.periodKey,
            from: r.periodKey,
            to: addDays(r.periodKey, 6),
          })
        : periodTitle(monthPeriod(`${r.periodKey}-01`));
    const part = (label: string, v: string | null) => (v ? `${label} ${v.slice(0, 200)}` : null);
    return [
      `**${title.replace('まとめ', '')}**`,
      part('✅', r.good),
      part('🔧', r.bad),
      part('➡️', r.next),
    ]
      .filter(Boolean)
      .join('\n');
  });
  return ephemeral(
    `📝 **最近の振り返り**（${formatDateJa(todayOf(c.env, nowSeconds()))} 時点）\n\n${blocks.join('\n\n')}`.slice(
      0,
      2000,
    ),
  );
}

const handler = guarded('stats', async (c) => {
  switch (c.sub) {
    case 'week':
      return week(c);
    case 'month':
      return month(c);
    case 'profile':
      return profile(c);
    case 'ranking':
      return rankingView(c);
    case 'reflections':
      return reflections(c);
    default:
      return ephemeral('未対応のサブコマンドです。');
  }
});

export const statsCommand: Command = {
  definition: definition as unknown as Command['definition'],
  deferred: true,
  ephemeral: true,
  handler,
};
