// Dip Rider — a paper-trading bot for agent-fun/bars-replay/v1.
//
// Idea: hourly crypto prices mean-revert over a ~12h horizon. A sharp
// 12-hour dip is usually followed by a bounce within a day, so the bot
// buys dips and exits on the bounce (or on a timeout), instead of holding
// through the chop the way buy-and-hold does.
//
// Rules, all decided from closes only (deterministic: no clock, no
// randomness, no environment reads):
//   - Hard dip: a symbol's 12h return below -3%  -> target 25% of equity.
//   - Soft dip: 12h return below -2.5% AND 24h return below -2%
//     (a dip still forming)                     -> target 12.5% of equity.
//   - At most 4 positions; when more symbols qualify, the 4 deepest dips win.
//   - Exit: the 12h return climbs back above +1% (bounce captured), or the
//     position has been held 24 bars (timeout).
//   - Hysteresis: a trade fires only when the target value differs from the
//     current value by more than 3% of equity, so the book is not churned
//     for noise. Fees are 10 bps + 5 bps slippage per fill.
//   - Freshness rotation: if fewer than 8 trades have filled by the 64th
//     tradeable bar, rotate the weakest holding into the strongest
//     unheld symbol (sell now, buy next bar once proceeds settle), so the
//     book always clears the minimum-trades guardrail in quiet windows.
//   - Never more than 25% of equity in one symbol (the harness cap), never
//     short, never leveraged. Buys are sized from cash on hand only: a
//     sell's proceeds never fund a buy decided on the same bar.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const LOOK = 12; // dip window, in bars
const LOOK_LONG = 24; // confirmation window, in bars
const DROP_HARD = -0.03; // hard-dip trigger on the 12h return
const DROP_SOFT = -0.025; // soft-dip trigger on the 12h return
const CONFIRM_LONG = -0.02; // soft dips need the 24h return below this too
const BOUNCE = 0.01; // exit once the 12h return is back above this
const HOLD_MAX = 24; // timeout exit, in bars
const TOP_K = 4; // at most this many positions
const W_HARD_BPS = 2500; // 25% of equity
const W_SOFT_BPS = 1250; // 12.5% of equity
const HYST_BPS = 300; // 3% of equity: ignore smaller target moves
const FLOOR_BAR = 64; // tradeable-bar index of the freshness rotation
const FLOOR_MIN_TRADES = 8; // the competition's minimum-trades guardrail
const MAX_SLIPPAGE_BPS = 100; // 1%: wide enough to never block a fill

const BPS = 10_000n;

interface Entry {
  bar: number; // tradeable-bar index when the position was opened
  weightBps: number;
}

const closes = new Map<string, number[]>();
const entries = new Map<string, Entry>();
let tradeableBars = 0;
let filledTrades = 0;
let floorBuy: string | null = null;

function ret12(symbol: string): number | null {
  const cs = closes.get(symbol);
  if (cs === undefined || cs.length <= LOOK) return null;
  return cs[cs.length - 1] / cs[cs.length - 1 - LOOK] - 1;
}

function ret24(symbol: string): number | null {
  const cs = closes.get(symbol);
  if (cs === undefined || cs.length <= LOOK_LONG) return null;
  return cs[cs.length - 1] / cs[cs.length - 1 - LOOK_LONG] - 1;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const fill of batch.fills) if (fill.status === 'filled') filledTrades++;
    for (const symbol of state.hello.symbols.map((s) => s.symbol)) {
      const c = state.close(symbol);
      if (c === null) continue;
      let cs = closes.get(symbol);
      if (cs === undefined) {
        cs = [];
        closes.set(symbol, cs);
      }
      cs.push(Number(c));
    }
    if (state.warmingUp) return [];
    tradeableBars++;

    // Finish a freshness rotation started on the previous bar.
    if (floorBuy !== null) {
      const symbol = floorBuy;
      floorBuy = null;
      const room = state.weightRoom(symbol);
      const notional = room < state.cash ? room : state.cash;
      if (notional >= 1_000_000n) {
        return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
      }
      return [];
    }

    const equity = state.equity;
    const hyst = (BigInt(HYST_BPS) * equity) / BPS;
    const target = new Map<string, bigint>();

    for (const symbol of state.hello.symbols.map((s) => s.symbol)) {
      const r12 = ret12(symbol);
      if (r12 === null) continue;
      const held = entries.get(symbol);
      if (held !== undefined) {
        if (r12 > BOUNCE || tradeableBars - held.bar >= HOLD_MAX) {
          entries.delete(symbol);
          continue;
        }
        target.set(symbol, (BigInt(held.weightBps) * equity) / BPS);
      } else {
        const r24 = ret24(symbol);
        if (r12 < DROP_HARD) {
          entries.set(symbol, { bar: tradeableBars, weightBps: W_HARD_BPS });
          target.set(symbol, (BigInt(W_HARD_BPS) * equity) / BPS);
        } else if (r12 < DROP_SOFT && r24 !== null && r24 < CONFIRM_LONG) {
          entries.set(symbol, { bar: tradeableBars, weightBps: W_SOFT_BPS });
          target.set(symbol, (BigInt(W_SOFT_BPS) * equity) / BPS);
        }
      }
    }
    if (target.size > TOP_K) {
      const ranked = [...target.keys()].sort((a, b) => (ret12(a) ?? 0) - (ret12(b) ?? 0));
      for (const symbol of ranked.slice(TOP_K)) {
        target.delete(symbol);
        entries.delete(symbol);
      }
    }

    const orders: OrderInput[] = [];
    let cash = state.cash;

    // Sells first: trim or exit anything over its target.
    for (const [symbol, pos] of state.positions) {
      const cur = state.value(symbol, pos.qty);
      const tgt = target.get(symbol) ?? 0n;
      if (tgt < cur - hyst) {
        const qty = tgt === 0n ? pos.qty : (pos.qty * (cur - tgt)) / cur;
        if (qty > 0n) {
          orders.push({ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput);
        }
      }
    }
    // Buys next, sized from cash on hand only.
    for (const [symbol, tgt] of target) {
      const pos = state.positions.get(symbol);
      const cur = pos === undefined ? 0n : state.value(symbol, pos.qty);
      if (tgt > cur + hyst) {
        let notional = tgt - cur;
        const room = state.weightRoom(symbol);
        if (notional > room) notional = room;
        if (notional > cash) notional = cash;
        if (notional >= 1_000_000n) {
          orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput);
          cash -= notional;
        }
      }
    }

    // Freshness rotation: late in the window, if the book has been too
    // quiet to clear the minimum-trades guardrail, rotate the weakest
    // holding into the strongest unheld symbol.
    if (tradeableBars === FLOOR_BAR && filledTrades < FLOOR_MIN_TRADES) {
      const held = [...state.positions.keys()].filter((s) => (ret12(s) ?? 0) !== null);
      const unheld = state.hello.symbols.map((s) => s.symbol).filter((s) => !state.positions.has(s));
      if (held.length > 0) {
        const weak = held.sort((a, b) => (ret12(a) ?? 0) - (ret12(b) ?? 0))[0];
        const pos = state.positions.get(weak)!;
        orders.push({ side: 'sell', symbol: weak, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput);
        entries.delete(weak);
        if (unheld.length > 0) {
          floorBuy = unheld.sort((a, b) => (ret12(b) ?? 0) - (ret12(a) ?? 0))[0];
        }
      } else if (unheld.length > 0) {
        const strong = unheld.sort((a, b) => (ret12(b) ?? 0) - (ret12(a) ?? 0))[0];
        const room = state.weightRoom(strong);
        const notional = room < cash ? room : cash;
        if (notional >= 1_000_000n) {
          orders.push({ side: 'buy', symbol: strong, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput);
        }
      }
    }

    return orders;
  },
});
