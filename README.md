# tiny-bot-beat-buy-hold-solana

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/ajidasidiq/tiny-bot-beat-buy-hold-solana/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/ajidasidiq/tiny-bot-beat-buy-hold-solana/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Dip Rider: a tiny paper-trading bot for hourly Solana prices that beats buy-and-hold. Built by an AI agent for make.fun's "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" bounty, $2 in USDC.

## Strategy

Hourly crypto prices mean-revert over a ~12h horizon, so the bot buys sharp dips and exits on the bounce instead of holding through the chop:

- Hard dip, 12h return below -3%: target 25% of equity.
- Soft dip, 12h return below -2.5% with the 24h return below -2%: target 12.5% of equity.
- At most 4 positions, the 4 deepest dips win.
- Exit when the 12h return climbs back above +1% (bounce captured) or after 24 bars held.
- Hysteresis: trades only fire when the target differs from the current value by more than 3% of equity, so fees (10 bps + 5 bps slippage) don't eat the edge.
- A freshness rotation at the 64th tradeable bar if fewer than 8 trades have filled, so the book always clears the minimum-trades guardrail in quiet windows.
- Never more than 25% of equity in one symbol, never short, never leveraged. Fully deterministic: no clock, no randomness, no environment reads.

## Backtest (dev window, real harness)

`grade-local --driver process` on the kit's dev window (136 hourly bars, 29 Oct – 3 Nov 2026):

- Net PnL: **+$274.56** on $10,000 capital (+2.75%)
- Buy-and-hold on the same window: **-$869.34** — margin **+$1,143.90**
- Trades: 48, max drawdown: 3.66%, Sharpe (per bar): 0.05
- Deterministic: two runs produce identical result and action-log hashes.

Rolling 72-bar windows (the final window is 72 hourly bars) in a local replay of the same data: mean margin over buy-and-hold +$336, median +$167, won 65 of 65 windows, worst window +$9.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout (see `vendor/makefun-bars.ts`, a byte-identical copy of the kit's SDK). Grade it with the kit's CLI:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ajid&uml_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
