import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../store/redis.js', () => ({ redis: {} }));
vi.mock('../api/middleware/auth.js', () => ({ ensureAccount: vi.fn(async () => {}) }));
vi.mock('../engine/position.js', () => ({
  getClearinghouseState: vi.fn(), getOpenOrders: vi.fn(),
  getFrontendOpenOrders: vi.fn(), getOrderStatus: vi.fn(),
}));
vi.mock('../engine/fill.js', () => ({
  getUserFills: vi.fn(), getUserFillsByTime: vi.fn(),
}));
vi.mock('../engine/funding-history.js', () => ({ getUserFunding: vi.fn() }));
vi.mock('../config.js', () => ({
  config: {
    HL_API_URL: 'https://example.invalid',
    LOG_LEVEL: 'silent',
    FUNDING_INTERVAL_MS: 3_600_000,
  },
}));

const {
  HL_FUNDING_HISTORY_TIMEOUT_MS,
  HL_L2_BOOK_TIMEOUT_MS,
  HL_MARKET_SEED_TIMEOUT_MS,
  HL_PROXY_TIMEOUT_MS,
  HlUpstreamError,
  postHlInfo,
} = await import('../worker/hl-upstream.js');
const { infoRouter } = await import('../api/routes/info.js');
const { getL2Book } = await import('../utils/l2-cache.js');
const { fetchFundingRateAt } = await import('../worker/funding-worker.js');
const { Worker } = await import('../worker/index.js');

const HTML_502 = '<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>';

function html502(): Response {
  return new Response(HTML_502, { status: 502, headers: { 'content-type': 'text/html' } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function dnsFailure(): Error {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.hyperliquid.xyz'), { code: 'ENOTFOUND' });
  return new TypeError('fetch failed', { cause });
}

function timeoutFailure(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

async function ask(body: Record<string, unknown>) {
  const app = new Hono();
  app.route('/info', infoRouter);
  const response = await app.request('/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as unknown };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postHlInfo', () => {
  it('documents one positive timeout per caller', () => {
    expect(HL_PROXY_TIMEOUT_MS).toBe(10_000);
    expect(HL_L2_BOOK_TIMEOUT_MS).toBe(3_000);
    expect(HL_FUNDING_HISTORY_TIMEOUT_MS).toBe(5_000);
    expect(HL_MARKET_SEED_TIMEOUT_MS).toBe(10_000);
  });

  it('passes an abort signal and returns the decoded JSON payload', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ universe: [] }));

    await expect(postHlInfo({ type: 'meta' }, 1_000)).resolves.toEqual({ universe: [] });
    const init = spy.mock.calls[0][1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(spy.mock.calls[0][0]).toBe('https://example.invalid/info');
  });

  it('types an HTML 502 page as a status failure without decoding it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(html502());

    const err = await postHlInfo({ type: 'meta' }, 1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlUpstreamError);
    expect(err).toMatchObject({ failure: 'status', status: 502 });
    expect((err as Error).message).toBe('upstream HL meta answered HTTP 502');
  });

  it('types a 200 answer with a non-JSON content type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(HTML_502, { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    await expect(postHlInfo({ type: 'meta' }, 1_000)).rejects.toMatchObject({ failure: 'content_type' });
  });

  it('types an undecodable JSON body as malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"truncated', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(postHlInfo({ type: 'meta' }, 1_000)).rejects.toMatchObject({ failure: 'malformed' });
  });

  it('types a DNS failure as a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(dnsFailure());

    const err = await postHlInfo({ type: 'meta' }, 1_000).catch((e: unknown) => e);
    expect(err).toMatchObject({ failure: 'network' });
    expect((err as Error).message).toContain('ENOTFOUND');
  });

  it('aborts a hung upstream at its timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    }));

    const started = Date.now();
    const err = await postHlInfo({ type: 'meta' }, 25).catch((e: unknown) => e);
    expect(err).toMatchObject({ failure: 'timeout' });
    expect((err as Error).message).toBe('upstream HL meta timed out after 25 ms');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('/info proxy upstream failures', () => {
  it('answers an HTML 502 page with a 502 JSON error and caches nothing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(html502());

    const failed = await ask({ type: 'meta', dex: 'proxy-502' });
    expect(failed).toEqual({ status: 502, body: { error: 'upstream HL meta answered HTTP 502' } });

    spy.mockResolvedValueOnce(json({ universe: [] }));
    const recovered = await ask({ type: 'meta', dex: 'proxy-502' });
    expect(recovered).toEqual({ status: 200, body: { universe: [] } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers an upstream timeout with a 504 JSON error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeoutFailure());

    const { status, body } = await ask({ type: 'candleSnapshot', req: { coin: 'BTC' } });
    expect(status).toBe(504);
    expect(body).toEqual({ error: `upstream HL candleSnapshot timed out after ${HL_PROXY_TIMEOUT_MS} ms` });
  });

  it('answers a DNS failure with a 502 JSON error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(dnsFailure());

    const { status, body } = await ask({ type: 'predictedFundings', probe: 'dns' });
    expect(status).toBe(502);
    expect(body).toEqual({ error: expect.stringContaining('ENOTFOUND') });
  });

  it('treats an unknown proxied type the same way', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(html502());

    const { status } = await ask({ type: 'spotMeta', probe: 'default-path' });
    expect(status).toBe(502);
  });
});

describe('l2-cache upstream failures', () => {
  const book = { coin: 'X', levels: [[{ px: '1', sz: '1', n: 1 }], [{ px: '2', sz: '1', n: 1 }]], time: 1 };

  it('returns null on an HTML 502 page and does not cache the failure', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(html502());

    await expect(getL2Book('L2-502')).resolves.toBeNull();
    spy.mockResolvedValueOnce(json(book));
    const recovered = await getL2Book('L2-502');
    expect(recovered?.levels).toEqual(book.levels);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null on a timeout and on a DNS failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeoutFailure());
    await expect(getL2Book('L2-timeout')).resolves.toBeNull();

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(dnsFailure());
    await expect(getL2Book('L2-dns')).resolves.toBeNull();
  });

  it('returns null on a JSON answer without two level sides', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ levels: [[]] }));
    await expect(getL2Book('L2-malformed')).resolves.toBeNull();
  });
});

describe('funding worker fundingHistory upstream failures', () => {
  const T = 1_800_000_000_000;

  it('fails typed on an HTML 502 page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(html502());
    await expect(fetchFundingRateAt('BTC', T)).rejects.toMatchObject({
      name: 'HlUpstreamError', failure: 'status', status: 502,
    });
  });

  it('fails typed on a timeout and on a DNS failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeoutFailure());
    await expect(fetchFundingRateAt('BTC', T)).rejects.toMatchObject({ failure: 'timeout' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(dnsFailure());
    await expect(fetchFundingRateAt('BTC', T)).rejects.toMatchObject({ failure: 'network' });
  });

  it('returns the realized boundary row on a good answer', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json([{ coin: 'BTC', fundingRate: '0.0000125', premium: '0', time: T + 7 }]),
    );
    await expect(fetchFundingRateAt('BTC', T)).resolves.toEqual({ rate: '0.0000125', observedTime: T + 7 });
    expect(JSON.parse(String(spy.mock.calls[0][1]!.body))).toEqual({
      type: 'fundingHistory', coin: 'BTC', startTime: T, endTime: T + 3_600_000 - 1,
    });
    expect(spy.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('builder-dex ctx refresh upstream failures', () => {
  type SeedExtraDex = { seedExtraDex(dex: string): Promise<void> };

  it('fails typed on an HTML 502 page before touching redis', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(html502());
    const worker = new Worker() as unknown as SeedExtraDex;

    await expect(worker.seedExtraDex('xyz')).rejects.toMatchObject({
      name: 'HlUpstreamError', failure: 'status', status: 502,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails typed on a timeout and on a DNS failure of the ctx fetch', async () => {
    const perpDexs = () => json([null, { name: 'xyz' }]);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(perpDexs()).mockRejectedValueOnce(timeoutFailure())
      .mockResolvedValueOnce(perpDexs()).mockRejectedValueOnce(dnsFailure());
    const worker = new Worker() as unknown as SeedExtraDex;

    await expect(worker.seedExtraDex('xyz')).rejects.toMatchObject({ failure: 'timeout' });
    await expect(worker.seedExtraDex('xyz')).rejects.toMatchObject({ failure: 'network' });
  });
});
