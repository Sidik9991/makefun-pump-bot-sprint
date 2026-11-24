// Trailhead Pump 6h — a scale-in momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// Discipline: only buy mature curves whose buy flow is accelerating, scale in while the
// trade works, exit the whole position on a stop, a trailing stop, a fading flow, a whale
// sell, or a time limit. A drawdown guard halts new entries after a losing stretch. Tiny
// probe round trips keep the 20-coin guardrail covered on a short final window.
//
// Retuned for a 6-hour final window (boothlord config): a slightly weaker entry signal than
// the 24-hour sibling, a 1200-slot time limit, and probes paced against 6 hours.
//
// Deterministic: no clock, no randomness, no network. Every decision comes from the batch
// the harness just delivered (slot, events, marks, fills, account).

import type { Batch, Bot, BotState, Curve, OrderInput, TradeEventRecord } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Minimum curve age in slots before an entry is considered. */
  minAge: number;
  /** Maximum curve age in slots for an entry (young pumps run further). */
  maxAge: number;
  /** Real SOL reserve band a curve must sit in to be tradable. */
  realSolMin: number;
  realSolMax: number;
  /** Lookback window, in slots, for the entry flow signal. */
  windowSlots: number;
  /** Minimum net buy flow (buys minus sells, SOL) over the window. */
  minNetSol: number;
  /** Minimum number of buys in the window. */
  minBuys: number;
  /** Minimum distinct buyers in the window. */
  minBuyers: number;
  /** Minimum / maximum price rise over the window (fractions, e.g. 0.08 = +8%). */
  minUp: number;
  maxUp: number;
  /** Current price must be at least this share of the window high. */
  nearHigh: number;
  /** Largest share of window buy SOL one wallet may account for. */
  maxWalletShare: number;
  /** First buy size, SOL. */
  firstBuySol: number;
  /** Scale-in buy size, SOL. */
  addBuySol: number;
  /** Most SOL ever spent on one coin. */
  maxPerCoinSol: number;
  /** Most open positions at once (harness cap is 5). */
  maxPositions: number;
  /** Most SOL at cost across all positions. */
  maxCostSol: number;
  /** Stop loss vs cost (fraction, 0.30 = exit when value < 70% of cost). */
  stopLoss: number;
  /** Trailing stop arms once the position is up this much vs cost. */
  trailArmUp: number;
  /** Trailing stop: exit when value falls this far below its peak. */
  trailDrop: number;
  /** Fade window, in slots, for the exit flow signal. */
  fadeSlots: number;
  /** Exit when the fade-window net flow is below this many SOL. */
  fadeNetSol: number;
  /** Exit on any single sell of at least this many SOL. */
  bigSellSol: number;
  /** Time limit, in slots, unless the position is up at least timeLimitMinUp. */
  timeLimitSlots: number;
  timeLimitMinUp: number;
  /** Halt new entries when equity falls this far below its peak; resume within resumeDd. */
  haltDd: number;
  resumeDd: number;
  /** Probe pacing: spread the probe coin target over this many seconds of block time. */
  paceSecs: number;
  /** Probe coin target for the window. */
  targetCoins: number;
  /** Most probe buys in flight at once. */
  maxProbesInFlight: number;
  /** Probe buy size, SOL (a probe round trip must be >= 0.01 SOL). */
  probeBuySol: number;
  /** Max slippage on every order, bps. */
  slippageBps: number;
}

/** Tuned for a 6-hour final window (sweep mean over fail keys 11/22/33/44: +2.525 SOL,
 * worst key +1.224; the no-fail-draw backtest is +3.059 SOL). Retuned away from the
 * 24-hour sibling's numbers: a 300-slot signal window, no fade exit (it chopped
 * runners: 51 fade exits, 0 trailing-stop exits in the first tuned run), a 1200-slot
 * time limit, and much heavier scale-ins (0.6 SOL adds to 4 SOL per coin) — the
 * scale-in size is what turns the few runners into the profit. */
export const DEFAULT_PARAMS: Params = {
  minAge: 300,
  maxAge: 100000,
  realSolMin: 2,
  realSolMax: 60,
  windowSlots: 300,
  minNetSol: 0.8,
  minBuys: 4,
  minBuyers: 4,
  minUp: 0.02,
  maxUp: 1.5,
  nearHigh: 0.8,
  maxWalletShare: 0.6,
  firstBuySol: 0.2,
  addBuySol: 0.6,
  maxPerCoinSol: 4,
  maxPositions: 5,
  maxCostSol: 5,
  stopLoss: 0.3,
  trailArmUp: 0.1,
  trailDrop: 0.08,
  fadeSlots: 20,
  fadeNetSol: -100,
  bigSellSol: 5,
  timeLimitSlots: 1200,
  timeLimitMinUp: 0.05,
  haltDd: 0.08,
  resumeDd: 0.05,
  paceSecs: 21600,
  targetCoins: 30,
  maxProbesInFlight: 2,
  probeBuySol: 0.02,
  slippageBps: 500,
};

const LAMPORTS = 1_000_000_000n;

interface WinTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Pos {
  entrySlot: number;
  lastBuyPrice: number;
  peakValueSol: number;
  armed: boolean;
  probe: boolean;
}

function priceOf(c: Curve): number {
  const vt = Number(c.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(c.virtual_quote_reserves) / vt;
}

function tradePrice(t: TradeEventRecord): number {
  const vt = Number(t.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(t.virtual_quote_reserves) / vt;
}

export function createStrategy(p: Params): Bot {
  // Recent trades per mint, pruned to the entry window. Only mints that traded
  // recently are kept; the map is swept for stale mints every few hundred slots.
  const windows = new Map<string, WinTrade[]>();
  // Price snapshots per mint (one per batch the mint traded in, plus its create
  // price). The entry signal needs the price 40 slots ago, which is NOT the price
  // of the earliest trade inside the window when a mint trades sporadically.
  const snaps = new Map<string, { slot: number; price: number }[]>();
  // Bookkeeping for positions we hold, keyed by mint.
  const book = new Map<string, Pos>();
  // Mints already used for a guardrail probe (never entered for real afterwards).
  const probed = new Set<string>();
  // Mints we held and exited: never re-entered. Re-entering a dumped coin is how
  // a momentum bot bleeds — the same mint lost on 16 separate trips in one run.
  const dead = new Set<string>();
  // Mints with a probe buy still in flight (buy sent, fill not yet seen).
  const probePending = new Set<string>();
  // Distinct mints that completed a round trip of at least 0.01 SOL.
  const tripped = new Set<string>();
  let startBlockTime = -1;
  let lastBlockTime = -1;
  let lastSweepSlot = -1;
  let peakEquitySol = -1;
  let halted = false;

  function prune(slot: number): void {
    if (slot - lastSweepSlot < 500) return;
    lastSweepSlot = slot;
    for (const [mint, trades] of windows) {
      while (trades.length > 0 && trades[0]!.slot < slot - p.windowSlots) trades.shift();
      if (trades.length === 0 && !book.has(mint)) windows.delete(mint);
    }
    for (const [mint, ss] of snaps) {
      while (ss.length > 0 && ss[0]!.slot < slot - 2000) ss.shift();
      if (ss.length === 0 && !book.has(mint)) snaps.delete(mint);
    }
  }

  /** Price of the latest snapshot at or before (slot - span); 0 when unknown. */
  function priceAtOrBefore(mint: string, slot: number, span: number): number {
    const ss = snaps.get(mint);
    if (ss === undefined || ss.length === 0) return 0;
    const target = slot - span;
    let best = 0;
    for (const s of ss) {
      if (s.slot <= target) best = s.price;
      else break;
    }
    return best === 0 ? ss[0]!.price : best;
  }

  /** Highest snapshot price inside [slot - span, slot]. */
  function highInWindow(mint: string, slot: number, span: number): number {
    const ss = snaps.get(mint);
    if (ss === undefined) return 0;
    let high = 0;
    for (const s of ss) {
      if (s.slot < slot - span) continue;
      if (s.price > high) high = s.price;
    }
    return high;
  }

  function windowStats(mint: string, slot: number, span: number): {
    net: number;
    buys: number;
    buySol: number;
    buyers: Set<string>;
    maxWalletSol: number;
    firstPrice: number;
    highPrice: number;
    bigSell: boolean;
  } {
    const trades = windows.get(mint) ?? [];
    const from = slot - span;
    let net = 0;
    let buys = 0;
    let buySol = 0;
    const buyers = new Set<string>();
    const walletSol = new Map<string, number>();
    let firstPrice = 0;
    let highPrice = 0;
    let bigSell = false;
    for (const t of trades) {
      if (t.slot < from) continue;
      if (firstPrice === 0) firstPrice = t.price;
      if (t.price > highPrice) highPrice = t.price;
      if (t.buy) {
        net += t.sol;
        buys += 1;
        buySol += t.sol;
        buyers.add(t.user);
        walletSol.set(t.user, (walletSol.get(t.user) ?? 0) + t.sol);
      } else {
        net -= t.sol;
        if (t.sol >= p.bigSellSol) bigSell = true;
      }
    }
    let maxWalletSol = 0;
    for (const v of walletSol.values()) if (v > maxWalletSol) maxWalletSol = v;
    return { net, buys, buySol, buyers, maxWalletSol, firstPrice, highPrice, bigSell };
  }

  function equitySol(state: BotState): number {
    let e = Number(state.cash) / 1e9;
    for (const [mint, h] of state.positions) {
      const c = state.curves.get(mint);
      if (c === undefined) continue;
      e += (Number(h.token_amount) * priceOf(c)) / 1e9;
    }
    return e;
  }

  function reconcile(state: BotState, slot: number): void {
    for (const [mint, h] of state.positions) {
      const rec = book.get(mint);
      if (rec === undefined) {
        const c = state.curves.get(mint);
        book.set(mint, {
          entrySlot: slot,
          lastBuyPrice: c === undefined ? 0 : priceOf(c),
          peakValueSol: (Number(h.token_amount) * (c === undefined ? 0 : priceOf(c))) / 1e9,
          armed: false,
          probe: probePending.has(mint) || probed.has(mint),
        });
        if (probePending.has(mint)) {
          probePending.delete(mint);
          probed.add(mint);
        }
      } else {
        const c = state.curves.get(mint);
        if (c !== undefined) {
          const v = (Number(h.token_amount) * priceOf(c)) / 1e9;
          if (v > rec.peakValueSol) rec.peakValueSol = v;
        }
      }
    }
    for (const mint of [...book.keys()]) {
      if (!state.positions.has(mint)) {
        const rec = book.get(mint)!;
        tripped.add(mint);
        if (!rec.probe) dead.add(mint);
        book.delete(mint);
      }
    }
  }

  return {
    onHello(state: BotState): void {
      peakEquitySol = Number(state.cash) / 1e9;
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      prune(slot);

      // Fold this batch's trades into the per-mint windows, and track block time.
      const touched = new Set<string>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (startBlockTime < 0) startBlockTime = e.block_time;
          lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const vt = Number(e.virtual_token_reserves);
          const price = vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0;
          if (price > 0) {
            let ss = snaps.get(e.mint);
            if (ss === undefined) {
              ss = [];
              snaps.set(e.mint, ss);
            }
            ss.push({ slot: e.slot, price });
          }
          continue;
        }
        if (e.event !== 'TradeEvent') continue;
        const t = e as TradeEventRecord;
        const price = tradePrice(t);
        if (price <= 0) continue;
        let arr = windows.get(t.mint);
        if (arr === undefined) {
          arr = [];
          windows.set(t.mint, arr);
        }
        arr.push({ slot: e.slot, buy: t.is_buy, sol: Number(t.sol_amount) / 1e9, user: t.user, price });
        touched.add(t.mint);
      }
      for (const mint of touched) {
        const arr = windows.get(mint)!;
        while (arr.length > 0 && arr[0]!.slot < slot - p.windowSlots) arr.shift();
        const c = state.curves.get(mint);
        if (c !== undefined) {
          const price = priceOf(c);
          if (price > 0) {
            let ss = snaps.get(mint);
            if (ss === undefined) {
              ss = [];
              snaps.set(mint, ss);
            }
            const last = ss[ss.length - 1];
            if (last === undefined || last.slot < slot) ss.push({ slot, price });
            else last.price = price;
          }
        }
      }

      // Buy fills refresh the last-buy price for scale-ins.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy') {
          const rec = book.get(f.mint);
          const c = state.curves.get(f.mint);
          if (rec !== undefined && c !== undefined) rec.lastBuyPrice = priceOf(c);
        }
      }

      reconcile(state, slot);

      // --- drawdown guard -------------------------------------------------
      const equity = equitySol(state);
      if (peakEquitySol < 0) peakEquitySol = equity;
      if (equity > peakEquitySol) peakEquitySol = equity;
      if (halted) {
        if (equity >= (1 - p.resumeDd) * peakEquitySol) { halted = false; }
      } else if (equity < (1 - p.haltDd) * peakEquitySol) {
        halted = true;
      }

      const txFee = state.txFeeLamports();
      const pendingBuy = new Set<string>();
      const pendingSell = new Set<string>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
        else pendingSell.add(po.order.mint);
      }
      let costSol = 0;
      for (const h of state.positions.values()) costSol += Number(h.cost_lamports) / 1e9;
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') costSol += Number(po.order.quote_lamports) / 1e9;
      }

      const tryBuy = (mint: string, wantSol: number): void => {
        if (state.committedPositionCount() >= p.maxPositions) return;
        if (pendingBuy.has(mint)) return;
        const cap = state.maxBuyLamports(mint);
        if (cap <= 0n) return;
        let spend = BigInt(Math.floor(wantSol * 1e9));
        if (spend > cap) spend = cap;
        if (spend < 10_000_000n) return; // below 0.01 SOL is not worth the tx fee
        if (state.freeCashLamports() < spend + 2n * txFee) return;
        if (costSol + Number(spend) / 1e9 > p.maxCostSol + 1e-9) return;
        costSol += Number(spend) / 1e9;
        pendingBuy.add(mint);
        orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: p.slippageBps });
      };

      // --- exits + scale-ins on open positions ----------------------------
      for (const [mint, h] of state.positions) {
        const rec = book.get(mint);
        if (rec === undefined) continue;
        const c = state.curves.get(mint);
        if (c === undefined || c.complete) continue;
        const price = priceOf(c);
        if (price <= 0) continue;
        const cost = Number(h.cost_lamports) / 1e9;
        const value = (Number(h.token_amount) * price) / 1e9;
        if (cost <= 0) continue;
        const sellAll = (): void => {
          if (pendingSell.has(mint)) return;
          pendingSell.add(mint);
          orders.push({ side: 'sell', mint, token_amount: BigInt(h.token_amount), max_slippage_bps: p.slippageBps });
        };
        // Probe positions close on the first batch after the buy fills.
        if (rec.probe) {
          sellAll();
          continue;
        }
        const up = value / cost - 1;
        if (value < (1 - p.stopLoss) * cost) {
          sellAll();
          continue;
        }
        if (up >= p.trailArmUp) rec.armed = true;
        if (rec.armed && value < (1 - p.trailDrop) * rec.peakValueSol) {
          sellAll();
          continue;
        }
        const fade = windowStats(mint, slot, p.fadeSlots);
        if (fade.net < p.fadeNetSol || fade.bigSell) {
          sellAll();
          continue;
        }
        if (slot - rec.entrySlot > p.timeLimitSlots && up < p.timeLimitMinUp) {
          sellAll();
          continue;
        }
        // Scale in while the trade works: price above the last buy, at/above cost.
        const spent = cost;
        if (!pendingBuy.has(mint) && !pendingSell.has(mint) && spent < p.maxPerCoinSol - 1e-9) {
          if (price > rec.lastBuyPrice && value >= cost) {
            tryBuy(mint, Math.min(p.addBuySol, p.maxPerCoinSol - spent));
          }
        }
      }

      // --- new entries ------------------------------------------------------
      if (!halted) {
        for (const mint of touched) {
          if (orders.length >= 14) break;
          if (state.positions.has(mint) || pendingBuy.has(mint)) { continue; }
          if (probed.has(mint) || probePending.has(mint) || dead.has(mint)) continue;
          const c = state.curves.get(mint);
          if (c === undefined || c.complete || c.created_slot === null) continue;
          if (slot - c.created_slot < p.minAge) { continue; }
          if (slot - c.created_slot > p.maxAge) { continue; }
          const realSol = Number(c.real_quote_reserves) / 1e9;
          if (realSol < p.realSolMin || realSol > p.realSolMax) { continue; }
          const s = windowStats(mint, slot, p.windowSlots);
          if (s.buys < p.minBuys || s.buyers.size < p.minBuyers) { continue; }
          if (s.net < p.minNetSol) { continue; }
          if (s.buySol <= 0 || s.maxWalletSol / s.buySol > p.maxWalletShare) { continue; }
          const now = priceOf(c);
          if (now <= 0) continue;
          // Price rise measured against the price 40 slots ago (snapshot-based, so a
          // mint that trades sporadically is still measured over the full window).
          const startPrice = priceAtOrBefore(mint, slot, p.windowSlots);
          if (startPrice <= 0) continue;
          const up = now / startPrice - 1;
          if (up < p.minUp || up > p.maxUp) { continue; }
          const high = Math.max(now, highInWindow(mint, slot, p.windowSlots));
          if (now < p.nearHigh * high) { continue; }
          // Inflow must be accelerating into the newer half of the window.
          const half = windowStats(mint, slot, Math.floor(p.windowSlots / 2));
          if (half.net <= s.net - half.net) { continue; }
          tryBuy(mint, p.firstBuySol);
        }
      }

      // --- guardrail probes ---------------------------------------------------
      // Pace the probe coin count against block time so the 20-coin guardrail is
      // covered even on a quiet stretch; probes keep running while entries halt.
      if (startBlockTime >= 0 && lastBlockTime >= startBlockTime) {
        const elapsed = lastBlockTime - startBlockTime;
        const expected = (p.targetCoins * elapsed) / p.paceSecs;
        const probesFlying = probePending.size;
        if (tripped.size + probesFlying < expected && probesFlying < p.maxProbesInFlight && orders.length < 14) {
          for (const [mint, c] of state.curves) {
            if (probed.has(mint) || probePending.has(mint)) continue;
            if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
            if (c.complete || c.created_slot === null) continue;
            if (slot - c.created_slot < p.minAge) continue;
            const realSol = Number(c.real_quote_reserves) / 1e9;
            if (realSol < p.realSolMin || realSol > p.realSolMax) continue;
            const recent = windows.get(mint);
            if (recent === undefined || recent.length === 0) continue;
            const cap = state.maxBuyLamports(mint);
            if (cap < 15_000_000n) continue;
            let spend = BigInt(Math.floor(p.probeBuySol * 1e9));
            if (spend > cap) spend = cap;
            if (state.freeCashLamports() < spend + 2n * txFee) break;
            if (costSol + Number(spend) / 1e9 > p.maxCostSol + 1e-9) break;
            costSol += Number(spend) / 1e9;
            probePending.add(mint);
            pendingBuy.add(mint);
            orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: p.slippageBps });
            break;
          }
        }
      }

      return orders;
    },
  };
}
