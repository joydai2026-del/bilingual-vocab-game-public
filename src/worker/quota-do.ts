// QuotaDO: ONE Durable Object for the whole app (always addressed by the name
// "quota"), holding the daily spend counters and the server-side gloss cache.
//
// It is a thin shell around src/worker/quota.ts, for the same reason RoomDO is
// a thin shell around the room reducer: the rules stay testable without a
// Workers runtime. Everything here is HTTP plumbing.
//
// One instance means every request in the world serializes through one object,
// which is exactly what a global daily budget needs. The work per request is
// two or three small storage reads, so it is not a throughput concern at
// classroom scale.

import {
  MAX_GLOSS_ENTRIES,
  consume,
  getGlosses,
  parseConsumeRequest,
  parseRefundRequest,
  parseUsageRequest,
  putGlosses,
  refund,
  usage,
  type GlossEntry,
  type QuotaStorage,
} from './quota';

/** The one instance name. Used by the router, never varied. */
export const QUOTA_OBJECT_NAME = 'quota';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export class QuotaDO implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  private storage(): QuotaStorage {
    return this.ctx.storage as unknown as QuotaStorage;
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.replace(/^\/+/, '');
    const now = Date.now();

    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }

    // Every body is validated before a counter moves. This object is only
    // reachable from our own worker today, but a bad `count` or a missing limit
    // would silently corrupt the day's accounting, so it is checked anyway.
    switch (action) {
      case 'consume': {
        const req = parseConsumeRequest(body, now);
        if (!req.ok) return json({ error: req.error }, 400);
        return json(await consume(this.storage(), req.value));
      }
      case 'refund': {
        const req = parseRefundRequest(body, now);
        if (!req.ok) return json({ error: req.error }, 400);
        return json(await refund(this.storage(), req.value));
      }
      case 'usage': {
        const req = parseUsageRequest(body);
        if (!req.ok) return json({ error: req.error }, 400);
        return json(await usage(this.storage(), req.value.bucket, req.value.ip, now));
      }
      case 'gloss/get': {
        const words = Array.isArray(body.words) ? (body.words as string[]) : [];
        return json({ glosses: await getGlosses(this.storage(), words, now) });
      }
      case 'gloss/put': {
        const entries = Array.isArray(body.entries) ? (body.entries as GlossEntry[]) : [];
        const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : 0;
        // The cap travels with the request so it stays a policy var
        // (MAX_GLOSS_ENTRIES) rather than a number frozen into this object.
        const maxEntries =
          typeof body.maxEntries === 'number' ? body.maxEntries : MAX_GLOSS_ENTRIES;
        if (ttlMs > 0) await putGlosses(this.storage(), entries, now, ttlMs, maxEntries);
        return json({ ok: true });
      }
      default:
        return json({ error: 'unknown quota action' }, 404);
    }
  }
}

