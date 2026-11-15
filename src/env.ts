/** wrangler.jsonc の vars / d1_databases / secret に対応する型 */
export interface Env {
  DB: D1Database;

  /** 公開情報（vars） */
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_GUILD_ID: string;
  DEFAULT_TIMEZONE: string;

  /**
   * 「あとで読む」機能（src/features/readLater）。
   * SOURCE_CHANNEL_ID と OWNER_ID の両方が入っているときだけ動く。
   */
  READ_LATER_SOURCE_CHANNEL_ID?: string;
  /** 省略時は SOURCE と同じチャンネルに紹介する */
  READ_LATER_NOTIFY_CHANNEL_ID?: string;
  READ_LATER_OWNER_ID?: string;
  /** 例: "08:00"（DEFAULT_TIMEZONE での時刻） */
  READ_LATER_DIGEST_TIME?: string;
  READ_LATER_DIGEST_COUNT?: string;
  READ_LATER_SNOOZE_DAYS?: string;

  /** secret: `wrangler secret put DISCORD_BOT_TOKEN` */
  DISCORD_BOT_TOKEN: string;
}
