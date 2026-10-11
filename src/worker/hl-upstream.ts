import { config } from '../config.js';

/**
 * Upstream Hyperliquid `/info` calls.
 *
 * Every call carries an AbortSignal timeout and checks the HTTP status and the
 * response content type before decoding, so a hung connection, an HTML error
 * page (e.g. an HL 502), a DNS failure or a malformed body becomes a typed
 * `HlUpstreamError` instead of a hang or an undifferentiated exception.
 *
 * Timeout constants (milliseconds), one per caller:
 * - HL_PROXY_TIMEOUT_MS: the public `/info` proxy (src/api/routes/info.ts).
 * - HL_L2_BOOK_TIMEOUT_MS: the order path's L2 book fetch (src/utils/l2-cache.ts).
 *   Short, because a fill waits on it; on failure the fill uses its existing
 *   fallback price exactly as before.
 * - HL_FUNDING_HISTORY_TIMEOUT_MS: the funding worker's realized-rate lookup.
 *   Well inside one FUNDING_RETRY_MS cadence multiple so a hung call cannot eat
 *   the boundary's retry window.
 * - HL_MARKET_SEED_TIMEOUT_MS: startup seeding and the periodic builder-dex
 *   ctx refresh (src/worker/index.ts), below its 15 s refresh cadence.
 */
export const HL_PROXY_TIMEOUT_MS = 10_000;
export const HL_L2_BOOK_TIMEOUT_MS = 3_000;
export const HL_FUNDING_HISTORY_TIMEOUT_MS = 5_000;
export const HL_MARKET_SEED_TIMEOUT_MS = 10_000;

export type HlUpstreamFailure = 'timeout' | 'network' | 'status' | 'content_type' | 'malformed';

export class HlUpstreamError extends Error {
  readonly failure: HlUpstreamFailure;
  readonly status: number | null;

  constructor(failure: HlUpstreamFailure, message: string, status: number | null = null) {
    super(message);
    this.name = 'HlUpstreamError';
    this.failure = failure;
    this.status = status;
  }
}

function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && ((err as { name?: unknown }).name === 'TimeoutError'
      || (err as { name?: unknown }).name === 'AbortError');
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return `${err.message} (${cause.message})`;
  return err.message;
}

/**
 * POST `body` to HL `/info` and return the decoded JSON payload. Throws
 * `HlUpstreamError` on timeout, network failure, non-2xx status, a non-JSON
 * content type, or an undecodable body.
 */
export async function postHlInfo(body: unknown, timeoutMs: number): Promise<unknown> {
  const type = typeof body === 'object' && body !== null
    ? String((body as { type?: unknown }).type)
    : 'unknown';
  let response: Response;
  try {
    response = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new HlUpstreamError('timeout', `upstream HL ${type} timed out after ${timeoutMs} ms`);
    }
    throw new HlUpstreamError('network', `upstream HL ${type} request failed: ${describe(err)}`);
  }
  if (!response.ok) {
    // Drain the body so the connection is released; its content is not trusted.
    await response.body?.cancel().catch(() => undefined);
    throw new HlUpstreamError(
      'status',
      `upstream HL ${type} answered HTTP ${response.status}`,
      response.status,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType.trim())) {
    await response.body?.cancel().catch(() => undefined);
    throw new HlUpstreamError(
      'content_type',
      `upstream HL ${type} answered non-JSON content type ${JSON.stringify(contentType)}`,
      response.status,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (isTimeout(err)) {
      throw new HlUpstreamError('timeout', `upstream HL ${type} timed out after ${timeoutMs} ms`);
    }
    throw new HlUpstreamError('network', `upstream HL ${type} body read failed: ${describe(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HlUpstreamError('malformed', `upstream HL ${type} body is not valid JSON`, response.status);
  }
}

/** HTTP status the `/info` proxy answers for an upstream failure: 504 on timeout, else 502. */
export function upstreamErrorStatus(err: HlUpstreamError): 502 | 504 {
  return err.failure === 'timeout' ? 504 : 502;
}
