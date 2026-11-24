// Trailhead Pump 6h — a scale-in momentum bot for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the wire shim is
// the kit's sdk/ts/agentfun-bot.ts, vendored byte for byte as vendor/agentfun-bot.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
