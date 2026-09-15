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
import { getPnlSnapshot, PnlSnapshotError } from '../../engine/pnl.js';
import { getPnlSnapshotRequestSchema } from '../../types/pnl.js';
import {
  CashLedgerEvidenceError,
  CashLedgerEvidenceV2Error,
  getCashLedgerEvidence,
  getCashLedgerEvidenceV2,
  buildCashLedgerEvidenceV2Error,
} from '../../engine/cash-ledger-evidence.js';
import {
  CASH_LEDGER_EVIDENCE_ERROR_SCHEMA,
  cashLedgerEvidenceRequestSchema,
  encodeCashLedgerEvidenceReceipt,
  CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
  CashLedgerEvidenceV2CodecError,
  decodeCashLedgerEvidenceV2Request,
  encodeCashLedgerEvidenceV2Receipt,
} from '../../types/cash-ledger-evidence.js';

export const hypaperRouter = new Hono();

hypaperRouter.post('/', async (c) => {
  const rawRequest = c.req.raw.clone();
  const rawBody: unknown = await c.req.json();
  const body = rawBody as Record<string, unknown>;
  const type = rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
    && typeof (rawBody as Record<string, unknown>).type === 'string'
    ? (rawBody as Record<string, unknown>).type
    : undefined;

  if (type === 'getCashLedgerEvidence') {
    if (!config.CASH_LEDGER_EVIDENCE_ENABLED) {
      return c.json({
        schema_version: CASH_LEDGER_EVIDENCE_ERROR_SCHEMA,
        status: 'disabled',
        error_code: 'disabled',
      }, 403);
    }
    try {
      const request = cashLedgerEvidenceRequestSchema.parse(rawBody);
      const receipt = await getCashLedgerEvidence(request);
      const bytes = encodeCashLedgerEvidenceReceipt(receipt);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      logger.warn({ type }, 'Cash ledger evidence refused');
      if (err instanceof CashLedgerEvidenceError) {
        return c.json({
          schema_version: CASH_LEDGER_EVIDENCE_ERROR_SCHEMA,
          status: err.status === 500 ? 'error' : 'refused',
          error_code: err.code,
        }, err.status);
      }
      if (err instanceof ZodError) {
        return c.json({
          schema_version: CASH_LEDGER_EVIDENCE_ERROR_SCHEMA,
          status: 'refused',
          error_code: 'invalid_request',
        }, 400);
      }
      return c.json({
        schema_version: CASH_LEDGER_EVIDENCE_ERROR_SCHEMA,
        status: 'error',
        error_code: 'internal',
      }, 500);
    }
  }

  if (type === 'getCashLedgerEvidenceV2') {
    if (!config.CASH_LEDGER_EVIDENCE_V2_ENABLED) {
      return c.json({
        schema_version: CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
        status: 'disabled',
        error_code: 'disabled',
      }, 403);
    }
    let request;
    try {
      request = decodeCashLedgerEvidenceV2Request(await rawRequest.text());
    } catch {
      return c.json({
        schema_version: CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
        status: 'refused',
        error_code: 'invalid_request',
      }, 400);
    }
    try {
      const receipt = await getCashLedgerEvidenceV2(request);
      const bytes = encodeCashLedgerEvidenceV2Receipt(receipt);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      logger.warn({ type }, 'Cash ledger evidence V2 refused');
      if (err instanceof CashLedgerEvidenceV2Error) {
        const wire = buildCashLedgerEvidenceV2Error(err);
        return c.json(wire, err.status);
      }
      if (err instanceof CashLedgerEvidenceV2CodecError) {
        return c.json({
          schema_version: CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
          status: err.status === 500 ? 'error' : 'refused',
          error_code: err.code,
        }, err.status);
      }
      if (err instanceof ZodError) {
        return c.json({
          schema_version: CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
          status: 'refused',
          error_code: 'invalid_request',
        }, 400);
      }
      return c.json({
        schema_version: CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
        status: 'error',
        error_code: 'internal',
      }, 500);
    }
  }

  const user: string | undefined = typeof body?.user === 'string' ? body.user : undefined;

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  if (!user || typeof user !== 'string') {
    return c.json({ error: 'Missing user' }, 400);
  }
  const normalizedUser = user.toLowerCase();

  if (type === 'getPnlSnapshot') {
    if (!config.PNL_SNAPSHOT_ENABLED) {
      return c.json({
        type: 'pnlSnapshot',
        status: 'disabled',
        paper: true,
        error: 'Programme PnL snapshots are disabled on this host',
      }, 403);
    }
    try {
      const request = getPnlSnapshotRequestSchema.parse(body);
      return c.json(await getPnlSnapshot(normalizedUser, request.coins));
    } catch (err) {
      logger.warn({ err, type }, 'Programme PnL snapshot refused');
      if (err instanceof PnlSnapshotError) {
        return c.json({
          type: 'pnlSnapshot',
          status: 'refused',
          paper: true,
          error: err.message,
        }, err.status);
      }
      if (err instanceof ZodError) {
        return c.json({
          type: 'pnlSnapshot',
          status: 'refused',
          paper: true,
          error: err.message,
        }, 400);
      }
      return c.json({
        type: 'pnlSnapshot',
        status: 'error',
        paper: true,
        error: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  }

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
