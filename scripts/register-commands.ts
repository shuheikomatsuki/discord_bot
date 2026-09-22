/**
 * スラッシュコマンドを Discord に登録する。デプロイとは別作業で、
 * コマンド定義（名前・説明・オプション）を変えたときだけ実行すればよい。
 *
 *   npm run register             # DISCORD_GUILD_ID のサーバーへ登録（即時反映）
 *   npm run register -- --global # 全サーバーへ登録（反映に最大1時間）
 *   npm run register -- --clear  # 登録をすべて削除
 */
import { readFileSync } from 'node:fs';
import { commandDefinitions } from '../src/core/registry';
import { putGlobalCommands, putGuildCommands } from '../src/discord/rest';

function loadDevVars(path = '.dev.vars'): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      out[trimmed.slice(0, index).trim()] = trimmed
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

function requireVar(vars: Record<string, string>, name: string): string {
  const value = process.env[name] ?? vars[name];
  if (!value || value === 'REPLACE_ME') {
    throw new Error(`${name} が設定されていません（.dev.vars か環境変数で指定してください）`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');
  const global = args.includes('--global');

  const vars = loadDevVars();
  const token = requireVar(vars, 'DISCORD_BOT_TOKEN');
  const applicationId = requireVar(vars, 'DISCORD_APPLICATION_ID');
  const body = clear ? [] : commandDefinitions;

  if (global) {
    await putGlobalCommands(token, applicationId, body);
    console.log(`グローバルに ${body.length} 件登録しました（反映に最大1時間かかります）`);
  } else {
    const guildId = requireVar(vars, 'DISCORD_GUILD_ID');
    await putGuildCommands(token, applicationId, guildId, body);
    console.log(`ギルド ${guildId} に ${body.length} 件登録しました（即時反映）`);
  }

  for (const command of body) {
    console.log(`  /${command.name}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
