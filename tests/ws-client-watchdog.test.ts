import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const warn = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

const { HlWebSocketClient } = await import('../src/worker/ws-client.js');

const SILENCE_MS = 30_000;
const PING_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Deterministic in-memory transport. Every event is driven synchronously by
 * the test, so the whole suite runs on the fake clock with no I/O to wait on.
 */
class FakeSocket extends EventEmitter {
  readyState = CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  terminated = false;

  constructor(readonly url: string, private readonly autoPong: boolean) {
    super();
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if (this.autoPong && msg.method === 'ping') this.receive({ channel: 'pong' });
  }

  terminate(): void {
    this.terminated = true;
    this.shut();
  }

  close(): void {
    this.shut();
  }

  // Test-side controls.
  open(): void {
    this.readyState = OPEN;
    this.emit('open');
  }

  receive(msg: object): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  subscriptions(): unknown[] {
    return this.sent.filter((m) => m.method === 'subscribe').map((m) => m.subscription);
  }

  pings(): number {
    return this.sent.filter((m) => m.method === 'ping').length;
  }

  private shut(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }
}

const SUBS = [{ type: 'allMids' }, { type: 'activeAssetCtx', coin: 'BTC' }, { type: 'allMids', dex: 'xyz' }];

const silenceWarnings = () =>
  warn.mock.calls.filter((call) => String(call[1] ?? '').includes('silent for'));

describe('HlWebSocketClient silence watchdog', () => {
  let sockets: FakeSocket[];
  let client: InstanceType<typeof HlWebSocketClient> | null;

  beforeEach(() => {
    warn.mockClear();
    vi.useFakeTimers();
    sockets = [];
    client = null;
  });

  afterEach(() => {
    client?.close();
    vi.useRealTimers();
  });

  function makeClient({ autoPong = false, handler = vi.fn() } = {}) {
    const c = new HlWebSocketClient(handler, {
      url: 'ws://fake-hl',
      socketFactory: (url) => {
        const sock = new FakeSocket(url, autoPong);
        sockets.push(sock);
        return sock;
      },
      silenceMs: SILENCE_MS,
      pingMs: PING_MS,
      reconnectMinMs: RECONNECT_MIN_MS,
      reconnectMaxMs: 30_000,
    });
    for (const sub of SUBS) c.subscribe(sub);
    return c;
  }

  it('terminates a silent socket at exactly WS_SILENCE_MS, reconnects after backoff and resubscribes', () => {
    const handler = vi.fn();
    client = makeClient({ handler });
    client.connect();
    sockets[0].open();
    expect(sockets[0].subscriptions()).toEqual(SUBS);
    sockets[0].receive({ channel: 'allMids', data: { mids: { BTC: '1' } } });
    expect(handler).toHaveBeenCalledWith('allMids', { mids: { BTC: '1' } });

    // The heartbeat goes out at 20 s; the half-open peer never answers.
    vi.advanceTimersByTime(PING_MS);
    expect(sockets[0].pings()).toBe(1);

    vi.advanceTimersByTime(SILENCE_MS - PING_MS - 1);
    expect(sockets[0].terminated).toBe(false);
    expect(silenceWarnings()).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(sockets[0].terminated).toBe(true);
    expect(silenceWarnings()).toHaveLength(1);
    expect(silenceWarnings()[0][0]).toEqual({ silentForMs: SILENCE_MS, silenceMs: SILENCE_MS });
    expect(String(silenceWarnings()[0][1])).toContain(`silent for ${SILENCE_MS} ms`);

    // Reconnect only once the backoff delay has elapsed.
    vi.advanceTimersByTime(RECONNECT_MIN_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].subscriptions()).toEqual(SUBS);

    // The clean reconnect reset the backoff: a second silence reconnects after the minimum again.
    vi.advanceTimersByTime(SILENCE_MS);
    expect(sockets[1].terminated).toBe(true);
    expect(silenceWarnings()).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_MIN_MS - 1);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(sockets[2].subscriptions()).toEqual(SUBS);
  });

  it('measures silence from the last message, not from the open', () => {
    client = makeClient();
    client.connect();
    sockets[0].open();
    vi.advanceTimersByTime(10_000);
    sockets[0].receive({ channel: 'allMids', data: { mids: { BTC: '2' } } });

    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(sockets[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0].terminated).toBe(true);
    expect(silenceWarnings()[0][0]).toEqual({ silentForMs: SILENCE_MS, silenceMs: SILENCE_MS });
  });

  it('never trips while the server answers pings', () => {
    client = makeClient({ autoPong: true });
    client.connect();
    sockets[0].open();

    vi.advanceTimersByTime(15 * PING_MS);
    expect(sockets[0].pings()).toBe(15);
    expect(sockets[0].terminated).toBe(false);
    expect(silenceWarnings()).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it('terminates a handshake that never completes, with backoff growing until a clean open', () => {
    client = makeClient();
    client.connect();

    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(sockets[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0].terminated).toBe(true);
    expect(silenceWarnings()).toHaveLength(1);

    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sockets).toHaveLength(2);

    // Still no open: the next retry waits twice as long.
    vi.advanceTimersByTime(SILENCE_MS);
    expect(sockets[1].terminated).toBe(true);
    vi.advanceTimersByTime(2 * RECONNECT_MIN_MS - 1);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(sockets[2].subscriptions()).toEqual(SUBS);
  });

  it('stops pinging, watching and reconnecting after close()', () => {
    client = makeClient();
    client.connect();
    sockets[0].open();
    client.close();
    client = null;

    vi.advanceTimersByTime(10 * SILENCE_MS);
    expect(sockets[0].pings()).toBe(0);
    expect(sockets[0].terminated).toBe(false);
    expect(sockets).toHaveLength(1);
  });
});
