import type {
  APIApplicationCommandAutocompleteInteraction,
  APIApplicationCommandAutocompleteResponse,
  APIChatInputApplicationCommandInteraction,
  APIInteractionResponse,
  APIInteractionResponseCallbackData,
  APIMessageComponentInteraction,
  APIModalSubmitInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord-api-types/v10';
import type { Env } from '../env';

export interface BaseContext {
  env: Env;
  ctx: ExecutionContext;
}

export interface CommandContext extends BaseContext {
  interaction: APIChatInputApplicationCommandInteraction;
  /** サブコマンド名。`/remind once` なら 'once'。サブコマンドが無ければ undefined */
  sub: string | undefined;
}

export interface AutocompleteContext extends BaseContext {
  interaction: APIApplicationCommandAutocompleteInteraction;
  sub: string | undefined;
  /** 今フォーカスされているオプション名 */
  focused: string;
  /** 今フォーカスされているオプションの入力値 */
  value: string;
}

export interface ComponentContext extends BaseContext {
  interaction: APIMessageComponentInteraction;
  /** custom_id を `:` で割った残り。`v1:reminder:pause:01J...` なら ['01J...'] */
  args: string[];
}

export interface ModalContext extends BaseContext {
  interaction: APIModalSubmitInteraction;
  args: string[];
}

export interface Command {
  /** Discord にそのまま PUT できる定義 */
  definition: RESTPostAPIApplicationCommandsJSONBody;
  /**
   * true なら router が先に type:5 (DEFERRED) を返し、ハンドラの結果を
   * あとから PATCH する。D1 書き込みや外部 API を伴うコマンドで使う。
   */
  deferred?: boolean;
  /** deferred のとき、最初に返す「考え中…」を ephemeral にするか（既定 true） */
  ephemeral?: boolean;
  handler: (c: CommandContext) => Promise<APIInteractionResponseCallbackData>;
  autocomplete?: (c: AutocompleteContext) => Promise<APIApplicationCommandAutocompleteResponse>;
}

export type ComponentHandler = (c: ComponentContext) => Promise<APIInteractionResponse>;
export type ModalHandler = (c: ModalContext) => Promise<APIInteractionResponse>;

export interface CronJob {
  name: string;
  run: (env: Env, ctx: ExecutionContext) => Promise<void>;
}

/**
 * 1機能 = 1 Feature。src/features/<name>/index.ts が default export する。
 * 新機能は core/registry.ts に1行足すだけで有効になる。
 */
export interface Feature {
  name: string;
  commands?: Command[];
  /** custom_id の action 名 -> ハンドラ */
  components?: Record<string, ComponentHandler>;
  modals?: Record<string, ModalHandler>;
  cron?: CronJob[];
}
