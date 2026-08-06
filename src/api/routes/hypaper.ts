import { Hono } from 'hono';
import { ZodError } from 'zod';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { ensureAccount } from '../middleware/auth.js';
import { upsertUser, updateUserBalance } from '../../store/pg-sink.js';
import {
  getHistoricalReplay,
  HistoricalReplayError,
  importHistoricalReplay,
} from '../../engine/historical-replay.js';
import {
  getHistoricalReplayRequestSchema,
  importHistoricalReplayRequestSchema,
} from '../../types/historical-replay.js';

export const hypaperRouter = new Hono();

hypaperRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user;

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  if (!user || typeof user !== 'string') {
    return c.json({ error: 'Missing user' }, 400);
  }
  const normalizedUser = user.toLowerCase();

  if (type === 'importHistoricalReplay' || type === 'getHistoricalReplay') {
    if (!config.HISTORICAL_REPLAY_ENABLED) {
      return c.json({
        type: 'historicalReplay',
        status: 'disabled',
        paper: true,
        synthetic: true,
        historicalReplay: true,
        historical_replay: true,
        error: 'Historical replay is disabled on this host',
      }, 403);
    }
    try {
      if (type === 'importHistoricalReplay') {
        const request = importHistoricalReplayRequestSchema.parse(body);
        await ensureAccount(normalizedUser);
        return c.json(await importHistoricalReplay(normalizedUser, request.replay));
      }
      const request = getHistoricalReplayRequestSchema.parse(body);
      return c.json(await getHistoricalReplay(normalizedUser, request.batchId));
    } catch (err) {
      logger.warn({ err, type }, 'Historical replay refused');
      if (err instanceof HistoricalReplayError) {
        return c.json({
          type: 'historicalReplay',
          status: 'refused',
          paper: true,
          synthetic: true,
          historicalReplay: true,
          historical_replay: true,
          error: err.message,
        }, err.status);
      }
      if (err instanceof ZodError) {
        return c.json({
          type: 'historicalReplay',
          status: 'refused',
          paper: true,
          synthetic: true,
          historicalReplay: true,
          historical_replay: true,
          error: err.message,
        }, 400);
      }
      return c.json({
        type: 'historicalReplay',
        status: 'error',
        paper: true,
        synthetic: true,
        historicalReplay: true,
        historical_replay: true,
        error: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  }

  await ensureAccount(normalizedUser);

  try {
    switch (type) {
      case 'resetAccount': {
        // Clear all positions, orders, fills
        const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(normalizedUser));
        const pipeline = redis.pipeline();

        for (const asset of positionAssets) {
          pipeline.del(KEYS.USER_POS(normalizedUser, parseInt(asset, 10)));
        }
        pipeline.del(KEYS.USER_POSITIONS(normalizedUser));

        // Cancel all open orders
        const oids = await redis.zrange(KEYS.USER_ORDERS(normalizedUser), 0, -1);
        for (const oidStr of oids) {
          const oid = parseInt(oidStr, 10);
          pipeline.hset(KEYS.ORDER(oid), 'status', 'cancelled', 'updatedAt', Date.now().toString());
          pipeline.srem(KEYS.ORDERS_OPEN, oidStr);
          pipeline.srem(KEYS.ORDERS_TRIGGERS, oidStr);
        }

        pipeline.del(KEYS.USER_ORDERS(normalizedUser));
        pipeline.del(KEYS.USER_CLOIDS(normalizedUser));
        pipeline.del(KEYS.USER_FILLS(normalizedUser));
        pipeline.del(KEYS.USER_FUNDINGS(normalizedUser));

        // Reset balance
        pipeline.hset(KEYS.USER_ACCOUNT(normalizedUser), 'balance', config.DEFAULT_BALANCE.toString());

        await pipeline.exec();

        // Fire-and-forget sync to Postgres
        upsertUser(normalizedUser, config.DEFAULT_BALANCE.toString());

        return c.json({ status: 'ok', message: 'Account reset' });
      }

      case 'setBalance': {
        const balance = body.balance;
        if (balance === undefined || typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) {
          return c.json({ error: 'Missing or invalid balance (must be a finite non-negative number)' }, 400);
        }
        await redis.hset(KEYS.USER_ACCOUNT(normalizedUser), 'balance', balance.toString());

        // Fire-and-forget sync to Postgres
        updateUserBalance(normalizedUser, balance.toString());

        return c.json({ status: 'ok', balance: balance.toString() });
      }

      case 'getAccountInfo': {
        const account = await redis.hgetall(KEYS.USER_ACCOUNT(normalizedUser));
        return c.json({
          userId: account.userId,
          balance: account.balance,
          createdAt: parseInt(account.createdAt, 10),
        });
      }

      default: {
        return c.json({ error: `Unknown hypaper type: ${type}` }, 400);
      }
    }
  } catch (err) {
    logger.error({ err, type }, 'Hypaper error');
    return c.json({ error: String(err) }, 500);
  }
});
