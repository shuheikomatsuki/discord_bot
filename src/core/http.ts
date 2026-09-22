import type { APIInteraction } from 'discord-api-types/v10';
import { Hono } from 'hono';
import type { Env } from '../env';
import { handleInteraction } from './router';
import { verifyDiscordSignature } from './verify';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('discord-bot is running'));

app.post('/interactions', async (c) => {
  const rawBody = await c.req.text();

  const verified = await verifyDiscordSignature({
    publicKeyHex: c.env.DISCORD_PUBLIC_KEY,
    signature: c.req.header('x-signature-ed25519'),
    timestamp: c.req.header('x-signature-timestamp'),
    rawBody,
  });
  // Discord はここで 401 が返ることを Endpoint 登録時に確認してくる
  if (!verified) return c.text('invalid request signature', 401);

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(rawBody) as APIInteraction;
  } catch {
    return c.text('invalid JSON', 400);
  }

  const response = await handleInteraction(
    interaction,
    c.env,
    c.executionCtx as unknown as ExecutionContext,
  );
  return c.json(response);
});

export default app;
