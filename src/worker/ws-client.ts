import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type WsMessageHandler = (channel: string, data: unknown) => void;

/** The subset of a `ws` WebSocket the client uses; tests inject a fake. */
export interface HlSocket {
  readonly readyState: number;
  send(data: string): void;
  terminate(): void;
  close(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type HlSocketFactory = (url: string) => HlSocket;

const defaultSocketFactory: HlSocketFactory = (url) => new WebSocket(url);

export interface HlWebSocketClientOptions {
  url?: string;
  socketFactory?: HlSocketFactory;
  silenceMs?: number;
  pingMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/**
 * HL WebSocket client. Reconnects with exponential backoff on close, and runs
 * a silence watchdog: every inbound frame (data, subscription ack or pong)
 * records its arrival time; if none arrives for `silenceMs` the socket is
 * treated as half-open and terminated, which drives the same close ->
 * backoff -> reconnect -> resubscribe path. An application-level
 * {"method":"ping"} every `pingMs` keeps a healthy but quiet socket talking.
 */
export class HlWebSocketClient {
  private ws: HlSocket | null = null;
  private reconnectDelay: number;
  private shouldReconnect = true;
  private handler: WsMessageHandler;
  private subscriptions: object[] = [];
  private readonly url: string;
  private readonly socketFactory: HlSocketFactory;
  private readonly silenceMs: number;
  private readonly pingMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private lastMessageAt = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handler: WsMessageHandler, options: HlWebSocketClientOptions = {}) {
    this.handler = handler;
    this.url = options.url ?? config.HL_WS_URL;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.silenceMs = options.silenceMs ?? config.WS_SILENCE_MS;
    this.pingMs = options.pingMs ?? config.WS_PING_MS;
    this.reconnectMinMs = options.reconnectMinMs ?? config.WS_RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? config.WS_RECONNECT_MAX_MS;
    this.reconnectDelay = this.reconnectMinMs;
  }

  connect(): void {
    this.reconnectTimer = null;
    if (!this.shouldReconnect) return;
    logger.info({ url: this.url }, 'Connecting to HL WebSocket');
    const ws = this.socketFactory(this.url);
    this.ws = ws;
    // The watchdog also covers a handshake that never completes.
    this.lastMessageAt = Date.now();
    this.armSilenceTimer(this.silenceMs);

    ws.on('open', () => {
      if (this.ws !== ws) return;
      logger.info('HL WebSocket connected');
      this.reconnectDelay = this.reconnectMinMs;
      this.lastMessageAt = Date.now();
      this.startPing();
      this.sendSubscriptions();
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel && msg.data) {
          this.handler(msg.channel, msg.data);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse WS message');
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      logger.warn('HL WebSocket closed');
      this.stopTimers();
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'HL WebSocket error');
    });
  }

  subscribe(subscription: object): void {
    this.subscriptions.push(subscription);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    }
  }

  private sendSubscriptions(): void {
    for (const sub of this.subscriptions) {
      this.ws?.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
    }
  }

  private armSilenceTimer(delayMs: number): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.checkSilence(), delayMs);
  }

  private checkSilence(): void {
    this.silenceTimer = null;
    const ws = this.ws;
    if (!ws) return;
    const silentForMs = Date.now() - this.lastMessageAt;
    if (silentForMs < this.silenceMs) {
      this.armSilenceTimer(this.silenceMs - silentForMs);
      return;
    }
    logger.warn(
      { silentForMs, silenceMs: this.silenceMs },
      `HL WebSocket silent for ${silentForMs} ms (limit ${this.silenceMs} ms); terminating and reconnecting`,
    );
    // terminate(), not close(): a half-open peer never answers a close frame.
    // The resulting 'close' event drives the normal reconnect/backoff path.
    ws.terminate();
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, this.pingMs);
  }

  private stopTimers(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    logger.info({ delay: this.reconnectDelay }, 'Scheduling WS reconnect');
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
  }

  close(): void {
    this.shouldReconnect = false;
    this.stopTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
