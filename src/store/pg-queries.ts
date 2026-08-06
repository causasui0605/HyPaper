import { desc, eq, and, gte, lte } from 'drizzle-orm';
import { db } from './db.js';
import { fills, orders } from './schema.js';
import type { PaperFill } from '../types/order.js';

export async function getUserFillsPg(userId: string, limit = 100): Promise<PaperFill[]> {
  const rows = await db
    .select()
    .from(fills)
    .where(eq(fills.userId, userId))
    .orderBy(desc(fills.time))
    .limit(limit);

  return rows.map(rowToFill);
}

/** Read-only first-import guard; replay never writes programme rows to Postgres. */
export async function getUserExecutionPresencePg(userId: string): Promise<{
  orders: boolean;
  fills: boolean;
}> {
  const [orderRows, fillRows] = await Promise.all([
    db.select({ oid: orders.oid }).from(orders).where(eq(orders.userId, userId)).limit(1),
    db.select({ tid: fills.tid }).from(fills).where(eq(fills.userId, userId)).limit(1),
  ]);
  return { orders: orderRows.length !== 0, fills: fillRows.length !== 0 };
}

export async function getUserFillsByTimePg(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<PaperFill[]> {
  const conditions = [eq(fills.userId, userId), gte(fills.time, startTime)];
  if (endTime !== undefined) {
    conditions.push(lte(fills.time, endTime));
  }

  const rows = await db
    .select()
    .from(fills)
    .where(and(...conditions))
    .orderBy(desc(fills.time));

  return rows.map(rowToFill);
}

function rowToFill(row: typeof fills.$inferSelect): PaperFill {
  return {
    coin: row.coin,
    px: row.px,
    sz: row.sz,
    side: row.side as 'B' | 'A',
    time: row.time,
    startPosition: row.startPosition,
    dir: row.dir,
    closedPnl: row.closedPnl,
    hash: row.hash,
    oid: row.oid,
    crossed: row.crossed,
    fee: row.fee,
    tid: row.tid,
    cloid: row.cloid ?? undefined,
    feeToken: row.feeToken,
  };
}
