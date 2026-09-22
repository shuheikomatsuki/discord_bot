/** wrangler.jsonc の vars / d1_databases / secret に対応する型 */
export interface Env {
  DB: D1Database;

  /** 公開情報（vars） */
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_GUILD_ID: string;
  DEFAULT_TIMEZONE: string;

  /** secret: `wrangler secret put DISCORD_BOT_TOKEN` */
  DISCORD_BOT_TOKEN: string;
}
