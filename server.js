// ShibaCoin Block Visualizer
// Serves a three.js + cannon-es physics scene that drops new blocks/transactions
// fetched from the local shibacoind via `shibacoin-cli`.
//
// Run directly:   node server.js
// Or under PM2:   pm2 start ecosystem.config.js
// Configuration is via environment variables; see README.md.
//
// No external npm dependencies — uses only Node built-ins.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const url    = require('url');

// ---------- Config ----------
const PORT          = parseInt(process.env.PORT || '3002', 10);
const HOST          = process.env.HOST || '127.0.0.1';                // localhost only by default; put a reverse proxy in front
const CLI           = process.env.SHIBACOIN_CLI || '/usr/local/bin/shibacoin-cli';
// Extra arguments put before every CLI call, e.g. "-conf=/path/shibacoin.conf"
// or "-datadir=/var/lib/shibacoin". Split on whitespace (no quoting).
const CLI_ARGS      = (process.env.SHIBACOIN_CLI_ARGS || '').trim().split(/\s+/).filter(Boolean);
const POLL_MS       = parseInt(process.env.POLL_MS || '6000', 10);    // full mempool+block cycle; matches client poll cadence
const TX_FETCH_CONCURRENCY = 4;                                       // parallel shibacoin-cli calls
const MAX_TX_PER_BLOCK     = 30;                                      // cap balls per block (biggest txs)
const RECENT_BLOCK_CACHE   = 6;                                       // how many recent blocks to keep in memory
const MAX_CACHED_TX        = 600;                                     // hard cap on tx cache size
const MAX_MEMPOOL_ENTRIES  = 100;                                     // cap pending-tx balls in the scene
const MAX_TX_LOOKUPS_PER_BLOCK = 200;                                 // per-tx getrawtransaction calls per block (fallback path only)
const SEED_BLOCKS          = 4;                                       // blocks loaded on first poll so the scene isn't empty
const ONDEMAND_BLOCK_CACHE = 32;                                      // LRU size for /api/block/:h heights outside recentBlocks
const MAX_ONDEMAND_INFLIGHT = 2;                                      // concurrent /api/block/:h fetches; beyond this -> 503
// ----------------------------

// In-memory state
let bestHeight      = 0;            // latest block height ingested into recentBlocks
let initialized     = false;        // set once the first getblockcount succeeds
let polling         = false;        // re-entrancy guard: a slow poll must not overlap the next one
const recentBlocks  = [];           // [{ height, hash, size, txCount, txs:[{txid,size,vsize}] }], ascending height
const blockCache    = new Map();    // height -> block entry; LRU for /api/block/:h outside recentBlocks
const inflightBlocks = new Map();   // height -> Promise, so concurrent /api/block/:h requests share one fetch
const txCache       = new Map();    // txid -> {size, vsize}; LRU, consulted before any getrawtransaction
const mempool       = new Map();    // txid -> {txid,size,vsize,fee,time}; mirrors the node's mempool (capped)
const stats         = {
  starts: 0, blocksServed: 0, txsServed: 0, mempoolServed: 0,
  txLookupFailures: 0,              // getrawtransaction failures (usually: node runs without -txindex)
  getblockVerbosity2: null,         // null = not probed yet; true/false once known
  lastPollAt: null,
  lastError: null,                  // cleared again after a fully successful poll
};
let warnedTxLookup  = false;

// Small LRU helpers on top of Map insertion order.
function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key); map.set(key, v);
  return v;
}
function lruSet(map, key, value, cap) {
  map.delete(key); map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
}

// ---------- shibacoin-cli helpers ----------
function runCli(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, [...CLI_ARGS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`shibacoin-cli timeout: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`shibacoin-cli exit ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

async function cliJson(args, timeoutMs) {
  const out = await runCli(args, timeoutMs);
  try { return JSON.parse(out); }
  catch (e) { throw new Error(`Bad JSON from ${args.join(' ')}: ${e.message}`); }
}

// Run an array of async thunks with bounded concurrency.
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e.message }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- Block ingestion ----------
// Normalise one entry of getblock's `tx` array. At verbosity 1 it's a txid
// string; at verbosity 2 it's an object that already carries the size.
function normTx(t) {
  if (typeof t === 'string') return { txid: t };
  if (!t || typeof t !== 'object') return null;
  const txid = t.txid || t.hash;
  if (!txid) return null;
  const size = Number(t.size) || (typeof t.hex === 'string' ? t.hex.length / 2 : 0);
  return size ? { txid, size, vsize: Number(t.vsize) || size } : { txid };
}

// getblock with every tx's size in one call, where the node supports it.
// Verbosity 2 needs no -txindex and saves one getrawtransaction per tx.
// The first call probes for support; if the node rejects "2" we remember
// that (stats.getblockVerbosity2 = false) and use verbosity 1 from then on.
async function getBlockJson(hash) {
  if (stats.getblockVerbosity2 !== false) {
    let blk = null;
    try {
      blk = await cliJson(['getblock', hash, '2']);
    } catch (e) {
      // Once known to work, or on a timeout, a failure is a real error.
      if (stats.getblockVerbosity2 === true || /timeout/i.test(e.message)) throw e;
      stats.getblockVerbosity2 = false;
      console.log(`[blockvisualizer] getblock verbosity 2 not supported (${e.message}); using per-tx lookups`);
    }
    if (blk) {
      if (stats.getblockVerbosity2 === null) {
        const supported = Array.isArray(blk.tx) && blk.tx.length > 0 && typeof blk.tx[0] === 'object';
        stats.getblockVerbosity2 = supported;
        console.log(`[blockvisualizer] getblock verbosity 2 ${supported ? 'supported' : 'not supported; using per-tx lookups'}`);
      }
      return blk;   // valid block either way; normTx handles both shapes
    }
  }
  return cliJson(['getblock', hash, '1']);
}

function noteTxLookupFailure(txid, e) {
  stats.txLookupFailures++;
  if (!warnedTxLookup) {
    warnedTxLookup = true;
    console.warn(`[blockvisualizer] getrawtransaction ${txid} failed: ${e.message}. ` +
      'For mined txs this usually means shibacoind runs without -txindex=1; ' +
      'those balls fall back to a 250 B placeholder size.');
  }
}

// Fetch one block and size its txs. Has no side effects on recentBlocks or
// the mempool map — callers decide what to do with the result.
// Returns { entry, txids }: txids is every txid in the block (coinbase
// included), which the poll loop uses to clear mined txs from the mempool.
async function fetchBlock(height) {
  const hash = (await runCli(['getblockhash', String(height)])).trim();
  const blk  = await getBlockJson(hash);
  const all  = (blk.tx || []).map(normTx).filter(Boolean);

  // Skip the coinbase (index 0) for ball spawning — it's the miner reward, not a real tx.
  // Size each tx from (in order) the block itself, txCache, or the mempool entry.
  const sized   = [];
  const unknown = [];
  for (const t of all.slice(1)) {
    if (t.size) { sized.push(t); continue; }
    const c = lruGet(txCache, t.txid) || mempool.get(t.txid);
    if (c) sized.push({ txid: t.txid, size: c.size, vsize: c.vsize });
    else unknown.push(t.txid);
  }

  // Fallback: one getrawtransaction per tx we still can't size. Bounded so a
  // huge block can't fork thousands of shibacoin-cli processes.
  const looked = await mapWithLimit(unknown.slice(0, MAX_TX_LOOKUPS_PER_BLOCK), TX_FETCH_CONCURRENCY, async (txid) => {
    try {
      const raw = await cliJson(['getrawtransaction', txid, '1']);
      return { txid, size: raw.size || 0, vsize: raw.vsize || raw.size || 0 };
    } catch (e) {
      noteTxLookupFailure(txid, e);
      // Placeholder; deliberately not cached so it's retried if the block is fetched again.
      return { txid, size: 250, vsize: 250, stub: true };
    }
  });

  const candidates = sized.concat(looked.filter(t => t && !t.__error));
  for (const t of candidates) {
    if (!t.stub) lruSet(txCache, t.txid, { size: t.size, vsize: t.vsize }, MAX_CACHED_TX);
  }

  // Sort by size desc, take top N so we don't spawn 5000 balls for a busy block.
  const txs = candidates.sort((a, b) => b.size - a.size).slice(0, MAX_TX_PER_BLOCK);

  const entry = {
    height: Number.isFinite(blk.height) ? blk.height : height,
    hash,
    size: Number(blk.size) || 0,
    txCount: all.length,
    txs,
    time: blk.time,
  };
  return { entry, txids: all.map(t => t.txid) };
}

// Poll-loop only: add a freshly mined block to the recent list and drop its
// txs from the pending set.
function addRecentBlock(entry, txids) {
  if (!recentBlocks.some(b => b.height === entry.height)) {
    recentBlocks.push(entry);
    recentBlocks.sort((a, b) => a.height - b.height);
    while (recentBlocks.length > RECENT_BLOCK_CACHE) recentBlocks.shift();
    stats.blocksServed++;
    stats.txsServed += entry.txs.length;
  }
  for (const txid of txids) mempool.delete(txid);
  stats.mempoolServed = mempool.size;
}

// ---------- Mempool ingestion ----------
// Pull the current pending tx set with `getrawmempool true`. Each entry
// already includes size/vsize/fee/time, so there's no second
// getrawtransaction roundtrip per tx. The map mirrors the node: txs that
// left the node's mempool without being mined (RBF, expiry, eviction) are
// dropped here too, so the "Mempool pending" count stays accurate.
// Throws on CLI failure; pollOnce records the error.
async function pollMempool() {
  const mp = await cliJson(['getrawmempool', 'true'], 6000);
  if (!mp || typeof mp !== 'object') throw new Error('unexpected getrawmempool output');
  // Tolerate a node that ignores the verbose flag and returns a bare txid array.
  const entries = Array.isArray(mp) ? mp.map(txid => [txid, {}]) : Object.entries(mp);
  const live = new Set(entries.map(([txid]) => txid));
  for (const [txid, e] of Array.from(mempool)) {
    if (live.has(txid)) continue;
    // Gone from the node's mempool: either mined (the block usually lands a
    // poll or two later) or evicted. Keep its size in txCache so fetchBlock
    // can size it without a getrawtransaction call (or -txindex).
    lruSet(txCache, txid, { size: e.size, vsize: e.vsize }, MAX_CACHED_TX);
    mempool.delete(txid);
  }

  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  for (const [txid, e] of entries) {
    if (!e || typeof e !== 'object') continue;
    const size  = Number(e.size  || e.vsize || 250);
    const vsize = Number(e.vsize || e.size  || 250);
    if (!mempool.has(txid)) added++;
    mempool.set(txid, {
      txid,
      size,
      vsize,
      fee:  Number(e.fee  || 0),
      time: Number(e.time || now),
    });
  }
  // Cap to the most recent MAX_MEMPOOL_ENTRIES so a busy mempool doesn't
  // spawn thousands of balls. Sort by time desc, then drop the tail.
  if (mempool.size > MAX_MEMPOOL_ENTRIES) {
    const keep = Array.from(mempool.values())
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_MEMPOOL_ENTRIES);
    mempool.clear();
    for (const e of keep) mempool.set(e.txid, e);
  }
  stats.mempoolServed = mempool.size;
  return added;
}

async function pollOnce() {
  // setInterval doesn't wait for us. If the previous cycle is still running
  // (slow CLI, big block), skip this tick instead of running two at once.
  if (polling) return;
  polling = true;
  let hadError = false;
  const fail = (msg) => { hadError = true; stats.lastError = msg; };

  try {
    // 1. Mempool first (cheap, one RPC, gives us pending tx data immediately)
    try { await pollMempool(); }
    catch (e) { fail(`mempool: ${e.message}`); }

    // 2. Then blocks (heavier)
    try {
      const count = parseInt((await runCli(['getblockcount'])).trim(), 10);
      if (!Number.isFinite(count)) throw new Error('bad getblockcount');

      if (!initialized) {
        // First poll: start SEED_BLOCKS below the tip so the scene isn't empty.
        bestHeight = Math.max(-1, count - SEED_BLOCKS);
        initialized = true;
      } else if (count - bestHeight > RECENT_BLOCK_CACHE) {
        // Far behind (node resync, long outage): only the newest
        // RECENT_BLOCK_CACHE blocks would survive anyway, so skip the rest.
        bestHeight = count - RECENT_BLOCK_CACHE;
      }

      while (bestHeight < count) {
        const h = bestHeight + 1;
        try {
          const { entry, txids } = await fetchBlock(h);
          addRecentBlock(entry, txids);
          bestHeight = h;
        } catch (e) {
          // Leave bestHeight where it is; this height is retried next poll.
          fail(`block ${h}: ${e.message}`);
          break;
        }
      }
    } catch (e) {
      fail(e.message);
    }

    stats.lastPollAt = new Date().toISOString();
    if (!hadError) stats.lastError = null;
  } finally {
    polling = false;
  }
}

// ---------- HTTP server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      return send(res, 200, html, { 'Content-Type': MIME['.html'] });
    }

    if (p === '/api/state') {
      return send(res, 200, JSON.stringify({
        bestHeight,
        recentBlocks,
        mempool: Array.from(mempool.values()),
        txCount: txCache.size,
        mempoolCount: mempool.size,
        stats,
      }), { 'Content-Type': MIME['.json'] });
    }

    if (p.startsWith('/api/block/')) {
      const json = { 'Content-Type': MIME['.json'] };
      const raw = p.slice('/api/block/'.length);
      if (!/^\d{1,10}$/.test(raw)) return send(res, 400, '{"error":"bad height"}', json);
      const h = parseInt(raw, 10);
      if (!initialized) return send(res, 503, '{"error":"starting up"}', { ...json, 'Retry-After': '5' });
      if (h > bestHeight) return send(res, 404, '{"error":"beyond best known height"}', json);

      // Recent blocks come straight from the poll loop's list. Older heights
      // go into a separate LRU so they never displace recentBlocks (and so
      // never show up as new cubes in the scene).
      const cached = recentBlocks.find(b => b.height === h) || lruGet(blockCache, h);
      if (cached) return send(res, 200, JSON.stringify(cached), json);

      let pending = inflightBlocks.get(h);
      if (!pending) {
        // This route is public via nginx; bound how many uncached fetches
        // (each one several shibacoin-cli processes) can run at once.
        if (inflightBlocks.size >= MAX_ONDEMAND_INFLIGHT) {
          return send(res, 503, '{"error":"busy, retry shortly"}', { ...json, 'Retry-After': '2' });
        }
        pending = fetchBlock(h)
          .then(({ entry }) => { lruSet(blockCache, h, entry, ONDEMAND_BLOCK_CACHE); return entry; })
          .finally(() => inflightBlocks.delete(h));
        inflightBlocks.set(h, pending);
      }
      try {
        return send(res, 200, JSON.stringify(await pending), json);
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }), json);
      }
    }

    if (p === '/api/health') {
      return send(res, 200, JSON.stringify({ ok: true, bestHeight, ...stats }), { 'Content-Type': MIME['.json'] });
    }

    // Static file fallback (e.g. favicon)
    const safe = path.normalize(decodeURIComponent(p)).replace(/^\/+/, '');
    if (safe && !safe.startsWith('..')) {
      const file = path.join(__dirname, 'public', safe);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      }
    }

    send(res, 404, '{"error":"not found"}', { 'Content-Type': MIME['.json'] });
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': MIME['.json'] });
  }
});

// ---------- Boot ----------
stats.starts++;
console.log(`[blockvisualizer] starting on http://${HOST}:${PORT}`);
console.log(`[blockvisualizer] using shibacoin-cli at ${CLI}${CLI_ARGS.length ? ' ' + CLI_ARGS.join(' ') : ''}`);

server.listen(PORT, HOST, () => {
  // Kick off an initial poll, then schedule.
  pollOnce().then(() => {
    setInterval(pollOnce, POLL_MS);
    console.log(`[blockvisualizer] polling every ${POLL_MS}ms; current bestHeight=${bestHeight}`);
  });
});

// Graceful shutdown
function shutdown() {
  console.log('[blockvisualizer] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
