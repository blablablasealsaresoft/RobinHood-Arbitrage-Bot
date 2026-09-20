// Sanitized snapshot for the Hub beta. Measurement only: no signer, no --live.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MISS_KINDS = Object.freeze([
  'not-repayable',
  'quote-needed',
  'fomo-owned-unsupported',
  'no-supported-alternate',
  'unsupported-hook',
  'fee-floor-negative',
  'stale',
  'parity-failed',
  'ev-negative',
]);

export const DEFAULT_HUB_N1_STATUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'registries',
  'hub-n1-status.json',
);

export const DIAGNOSTIC_TOKEN = '0x4276331ccfcd3bd66dc88cece616dc2ca6d988e4';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sanitizeMisses(input) {
  const misses = {};
  for (const kind of MISS_KINDS) misses[kind] = num(input?.[kind]);
  return misses;
}

function sanitizeRow(row) {
  if (!row?.token) return null;
  return {
    token: String(row.token).toLowerCase(),
    stage: String(row.stage || 'venues-0'),
    triggerCount: num(row.triggerCount),
    firstTriggerBlock: row.firstTriggerBlock == null ? null : num(row.firstTriggerBlock, null),
    lastTriggerBlock: row.lastTriggerBlock == null ? null : num(row.lastTriggerBlock, null),
    venueCount: num(row.venueCount),
    supportedVenueCount: num(row.supportedVenueCount),
    ownedVenueCount: num(row.ownedVenueCount),
    timeToFirstSupportedVenue: row.timeToFirstSupportedVenue == null ? null : num(row.timeToFirstSupportedVenue, null),
    timeToSecondSupportedVenue: row.timeToSecondSupportedVenue == null ? null : num(row.timeToSecondSupportedVenue, null),
  };
}

function sanitizeFunnel(funnel = {}) {
  return {
    blocks: num(funnel.blocks),
    triggers: num(funnel.triggers),
    affected: num(funnel.affected),
    multiVenue: num(funnel.multiVenue),
    supportedLoops: num(funnel.supportedLoops),
    repayable: num(funnel.repayable),
    evPositive: num(funnel.evPositive),
    n1: num(funnel.n1),
    candidate_rate: rate(funnel.candidate_rate),
    repayable_rate: rate(funnel.repayable_rate),
    closestNegativeBps: funnel.closestNegativeBps == null ? null : num(funnel.closestNegativeBps, null),
    freshnessDeaths: num(funnel.freshnessDeaths),
    parityDeaths: num(funnel.parityDeaths),
    economicDeaths: num(funnel.economicDeaths),
    misses: sanitizeMisses(funnel.misses),
  };
}

export function buildHubN1Status({
  funnel = {},
  lifecycle = {},
  pools = {},
  transport = {},
  now = Date.now(),
} = {}) {
  const rows = (lifecycle.rows || []).map(sanitizeRow).filter(Boolean)
    .sort((a, b) => num(b.lastTriggerBlock) - num(a.lastTriggerBlock));
  const diagnostic = rows.find((row) => row.token === DIAGNOSTIC_TOKEN) || null;
  return {
    mode: 'shadow-n1',
    signing: false,
    broadcasting: false,
    live: false,
    updatedAt: now,
    lastBlock: transport.lastBlock == null ? null : num(transport.lastBlock, null),
    funnel: sanitizeFunnel(funnel),
    lifecycle: {
      tokens: num(lifecycle.tokens),
      venues0: num(lifecycle.venues0),
      venues1: num(lifecycle.venues1),
      venues2: num(lifecycle.venues2),
      supported1: num(lifecycle.supported1),
      supported2: num(lifecycle.supported2),
      ownedOnly: num(lifecycle.ownedOnly),
      still_owned_only_rate: rate(lifecycle.still_owned_only_rate),
      graduate_rate_supported: rate(lifecycle.graduate_rate_supported),
      diagnostic,
      recent: rows.slice(0, 8),
    },
    pools: {
      known: num(pools.known),
      withToken: num(pools.withToken),
      unresolved: num(pools.unresolved),
      resolved_rate: rate(pools.resolved_rate),
    },
    transport: {
      feed_ws_connects: num(transport.feed_ws_connects),
      feed_ws_disconnects: num(transport.feed_ws_disconnects),
      feed_blocks: num(transport.feed_blocks),
      poll_blocks: num(transport.poll_blocks),
      deduped_blocks: num(transport.deduped_blocks),
      missed_sequence_gaps: num(transport.missed_sequence_gaps),
      lastBlock: transport.lastBlock == null ? null : num(transport.lastBlock, null),
    },
  };
}

export function writeHubN1Status(status, path = process.env.HUB_SHADOW_STATUS_PATH || DEFAULT_HUB_N1_STATUS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status)}\n`);
  return path;
}
