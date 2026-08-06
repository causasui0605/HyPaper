export const KEYS = {
  // Market data
  MARKET_MIDS: 'market:mids',
  MARKET_CTX: (coin: string) => `market:ctx:${coin}`,
  MARKET_L2: (coin: string) => `market:l2:${coin}`,
  MARKET_META: 'market:meta',
  //: builder-dex asset registry: field = wire asset id (>=100000),
  //: value = JSON {coin, szDecimals}. Main-dex assets stay in MARKET_META.
  MARKET_ASSET_MAP: 'market:assetmap',

  // User account
  USER_ACCOUNT: (userId: string) => `user:${userId}:account`,
  USER_POSITIONS: (userId: string) => `user:${userId}:positions`,
  USER_POS: (userId: string, asset: number) => `user:${userId}:pos:${asset}`,
  USER_LEV: (userId: string, asset: number) => `user:${userId}:lev:${asset}`,
  USER_ORDERS: (userId: string) => `user:${userId}:orders`,
  USER_CLOIDS: (userId: string) => `user:${userId}:cloids`,
  USER_FILLS: (userId: string) => `user:${userId}:fills`,
  USER_FUNDINGS: (userId: string) => `user:${userId}:fundings`,

  // Replay audit data never enters ordinary order/fill/funding schemas.
  HISTORICAL_REPLAY_INDEX: (userId: string) => `user:${userId}:hpr:index`,
  HISTORICAL_REPLAY_BATCH: (userId: string, batchId: string) => `user:${userId}:hpr:batch:${batchId}`,
  HISTORICAL_REPLAY_EVENTS: (userId: string, batchId: string) => `user:${userId}:hpr:events:${batchId}`,
  HISTORICAL_REPLAY_EVENT: (userId: string, eventId: string) => `user:${userId}:hpr:event:${eventId}`,

  // Orders
  ORDER: (oid: number) => `order:${oid}`,
  ORDERS_OPEN: 'orders:open',
  ORDERS_TRIGGERS: 'orders:triggers',

  // Active users (for funding)
  USERS_ACTIVE: 'users:active',

  // Sequences
  SEQ_OID: 'seq:oid',
  SEQ_TID: 'seq:tid',
} as const;
