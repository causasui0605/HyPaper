import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const envSchema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  HL_WS_URL: z.string().default('wss://api.hyperliquid.xyz/ws'),
  HL_API_URL: z.string().default('https://api.hyperliquid.xyz'),
  PORT: z.coerce.number().default(3000),
  DEFAULT_BALANCE: z.coerce.number().default(100_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WS_RECONNECT_MIN_MS: z.coerce.number().default(1000),
  WS_RECONNECT_MAX_MS: z.coerce.number().default(30000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  FEES_ENABLED: z.coerce.boolean().default(true),
  FEE_RATE_TAKER: z.string().default('0.00035'),
  FEE_RATE_MAKER: z.string().default('0.0001'),
  // Sterile programme replay is deliberately unavailable unless the host opts in.
  // Do not use z.coerce.boolean here: the string "false" is truthy in JavaScript.
  HISTORICAL_REPLAY_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // Read-only programme PnL snapshots are unavailable unless the paper host opts in.
  PNL_SNAPSHOT_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FUNDING_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  FUNDING_INTERVAL_MS: z.coerce.number().default(3_600_000),
  FUNDING_APPLY_DELAY_MS: z.coerce.number().default(30_000),
  FUNDING_MAX_LATE_MS: z.coerce.number().default(55_000),
  FUNDING_RETRY_MS: z.coerce.number().default(5_000),
  // Comma-separated builder-deployed perp dex names to mirror (e.g. "xyz").
  // Empty = main dex only (upstream behavior unchanged).
  EXTRA_DEXS: z.string().default(''),
  // Poll interval for extra-dex metaAndAssetCtxs (mids/mark/funding refresh
  // belt in addition to the per-dex allMids WS subscription).
  EXTRA_DEX_CTX_REFRESH_MS: z.coerce.number().default(15_000),
});

export const extraDexList = (raw: string): string[] =>
  raw.split(',').map((d) => d.trim()).filter((d) => d.length > 0);

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
