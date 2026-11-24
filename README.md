# makefun-pump-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![make.fun · rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Sidik9991/makefun-pump-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![make.fun · reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Sidik9991/makefun-pump-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Trailhead Pump 6h — a scale-in momentum bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty, $2 in USDC. Paper-trades pump.fun bonding curves on a 6-hour replay (agent-fun/replay/v2); highest net PnL wins.

## Strategy — Trailhead Pump 6h

One program, `main.ts` on Node 22. The wire shim is the kit's `sdk/ts/agentfun-bot.ts`, vendored byte for byte as `vendor/agentfun-bot.ts`; the strategy in `strategy.ts` was written fresh for this competition.

- **Entry** (all must hold): curve age ≥ 300 slots; real SOL reserve 2–60; 300-slot window net buy flow ≥ 0.8 SOL with ≥ 4 buys from ≥ 4 distinct buyers; price up 2–150% vs 300 slots ago and ≥ 80% of the window high; inflow accelerating into the newer half; no single wallet > 60% of window buy SOL.
- **Sizing**: first buy 0.2 SOL; add 0.6 SOL while the price is above the last buy and the position is at/above cost, up to 4 SOL per coin; max 5 positions, max 5 SOL at cost. The heavy scale-in is what turns the few runners into the profit.
- **Exits** (whole position): 30% stop vs cost; 8% trailing stop from the peak once up 10%; exit on any single sell ≥ 5 SOL; 1200-slot time limit unless up ≥ 5%. No fade exit — measured: it chopped runners (51 fade exits, 0 trailing-stop exits in the first tuned run).
- **No re-entry**: a coin we held and exited is never entered again — re-entering dumped coins was the biggest leak (one mint lost on 16 separate trips before the rule).
- **Drawdown guard**: new entries halt > 8% below peak equity, resume within 5%. Exits and guardrail probes keep running while halted.
- **Guardrail probes**: 0.02 SOL round trips, paced against 6 hours (30-coin target), keep the 20-coin guardrail covered on quiet stretches.
- **Deterministic**: no clock, no randomness, no network at replay time.

## Measured numbers (dev window 2026-11-02T03:09Z → 2026-11-03T03:09Z, 128,058 events)

- Offline sim, full 24 h dev window, default fail draw: net **+3.302 SOL**, 413 fills, 119 coins, 122 round trips, 14 wins, max DD 9.0%, 6 rejected, 8 failed; without failed txs +3.059; at 2× fees **+2.046**.
- Sweep mean over 4 fail keys (11/22/33/44): net **+2.525 SOL** (worst key +1.224), ex-best-trip +0.813. Kit pilot momentum baseline on the same window: −9.384 SOL.
- 6-hour slices: +0 h **+4.114 SOL** (33 coins, DD 5.1%); +6 h −0.138 (64 coins, DD 6.7%); +12 h −0.309 (64 coins, DD 8.7%); +18 h −2.842 on the default fail draw (22 coins, DD 28.4%; +0.193 without failed txs). Guardrails met on all four slices (≥ 20 coins, DD ≤ 50%). Honest read: the full-window score leans on the first 6 hours and on a few runners; the final window is a different 6 h, so the dev number is not a forecast.
- grade-local (process driver, commit 9ffddc6): net PnL **+1.409702 SOL** (return 14.10%, 90% interval −1.116..+4.419 SOL), 256 fills over 52 coins, 55 round trips, win rate 21.8%, max DD 10.4%, 6 rejected, 6 failed; fees 0.955 curve + 0.028 tx; at 2× fees +0.193 SOL. **Guardrails met** (52 coins with ≥ 0.01 SOL round trips). Top 3 coins made 69% of gains; without them −0.78 SOL. L1 regrade reproduced byte for byte (determinism confirmed). action_log_sha256 e6520c929332354cc08e610aa73ebe24dbe02d53366cf098c322acf4aefa0da6. Note: result_sha256 cannot equal the server's (local node v24.22.1 vs server harness v26.13.1) — expected, not a failure. The offline sim's +3.302 on the same commit differs because the grade-local fail draw and the real engine's trajectory diverge from the sim port's default draw (the 4-key sweep mean +2.525, worst +1.224, brackets it).

## Competition

- "Pump.fun Bot Sprint: Make Bot And Win", $2 (1st $1, 2nd $1), deadline 2026-11-28T08:00:00Z (15:00 WIB 28 Nov). Final window 6 h (08:00–14:00Z 28 Nov). Free entry, paper money only, blind rounds.
- Harness pumpfun-replay/v2: 10 SOL paper, long only, max 5 open positions, max order 100 bps of real reserve, max 16 orders/batch, latency 2 slots. Fees: protocol 95 bps + creator 30 bps fallback, base 5,000 + priority 100,000 lamports/tx, failed tx 200 bps. Guardrails: round trip ≥ 0.01 SOL on each of ≥ 20 coins, max drawdown ≤ 50%. Places by net PnL; a prize needs net PnL > 0 after every fee. Entry runs twice; the two action logs must match byte for byte.
- Note: this competition's own kit never built (kit endpoint returned 503 kit_pending at every retry), so the entry was built and graded against the sibling boothlord kit (same pumpfun-replay/v2 harness, same 24 h dev dataset) — see BUILD-STATUS.md in the workspace.
