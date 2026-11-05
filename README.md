# Coup RL Bot

A 1v1 [Coup](https://en.wikipedia.org/wiki/Coup_(card_game)) bot trained with PPO and an
LSTM memory, plus a browser demo at **https://coup.austxu.dev** where the whole game —
engine and neural network — runs client-side. No backend, no cold starts.

## How the demo works

```
            main thread                                   Web Worker
 ┌──────────────────────────────────────┐     ┌──────────────────────────────┐
 │ engine/game.ts   port of coup/game.py │     │ bot/model.ts                 │
 │   generator: yields each Prompt       │     │   fc1→relu→fc2→relu→LSTM(256)│
 │ engine/encode.ts 70-dim obs + mask    │──►  │   → actor logits, tanh critic│
 │ game/match.ts    paces events into    │ obs │   masked softmax, sampled    │
 │   animated beats, asks human or bot,  │ ◄── │   one LSTM state per seat    │
 │   records replay frames               │ π,v │ model/gen5.bin (1.23 MB)     │
 │ ui/*.tsx         Preact table + mind  │     └──────────────────────────────┘
 └──────────────────────────────────────┘
```

- `web/src/engine/game.ts` is a line-for-line port of `CoupGame`. Every agent call in
  Python is a `yield` of a prompt, so the order of prompts, state changes and shuffles
  is identical (challenge before block, block challenges routed through
  `choose_challenge`, lose-influence prompts only with two cards, forced Coup at 10+).
- `web/src/engine/encode.ts` ports `CoupEnv._encode_state` (observation + action mask)
  and the PPO agent's fixed exchange heuristic.
- `web/src/bot/` loads the weights in a Web Worker, keeps a separate LSTM state per
  seat for the whole game (like `PPOAgent.hidden_state`), and samples from the masked
  softmax — the same mixed strategy as production, not argmax. The UI adds a 0.5–1.1 s
  "thinking" delay so it feels human.
- The **bot's mind** panel shows, after every bot decision, its probability over the
  options it actually had and the critic's win estimate `(v+1)/2` as a sparkline. It
  never shows the bot's hidden cards during play. After the game, **Review** steps
  through every decision with both hands visible, bluff / challenge flags and the
  bot's policy at each point.
- PPO-AI's avatar is the Djungelskog pixel bear (`art/djungelskog-pixel`, the author's
  own animation frames), packed into one lazy-loaded WebP atlas.

### URL parameters

| Param | Effect |
| --- | --- |
| `?embed=1` | Hides page chrome; layout fits a ~16:10 iframe (`embed=portfolio` still works). |
| `?embed=1&autoplay=1` | Attract mode: Gen5 plays itself (both hands shown, slowed down) in a loop until the visitor clicks **Play the bot**. |

### Keyboard

`I F T S E A C` pick actions · `C`/`A` challenge or allow · `1`/`2` choose a block or a
card · `Enter` confirm an exchange · `N` new game · `R` review · `?` rules. Events are
narrated through an `aria-live` region; `prefers-reduced-motion` turns off flights and
flips and freezes the bear on its idle frame.

## Parity with the Python bot

`tools/make_parity_fixtures.py` plays recorded games with the Python engine and the
PyTorch model (PPO vs random, zoo, heuristic and PPO vs PPO, fixed seeds) and stores
every shuffle, every prompt with a full state snapshot, every answer, and for each PPO
decision the observation, mask, logits and value from both the original float32 weights
and the float16 weights the browser ships. `web/test/parity.test.ts` replays them
through the TypeScript engine and network:

- engine: identical prompt sequence, legal actions, state snapshots, action history,
  winner and number of shuffles in every game;
- encoder: observation and mask equal bit-for-bit;
- network vs the float16 reference: max |Δlogit| 3.3e-6, max |Δvalue| 8.4e-7
  (asserted < 1e-4);
- float16 vs the original float32 weights (quantisation drift): max |Δlogit| on legal
  actions 4.6e-3, max total-variation distance between policies 1.0e-3, same argmax in
  every decision (asserted TV < 5e-3).

The committed fixture holds 96 games / 1,437 PPO decisions (0.27 MB gzipped). A local
run over 1,000 games / 15,120 PPO decisions gave the same picture (max |Δlogit| 4.1e-6
vs fp16, max TV 1.9e-3 vs fp32): `PARITY_FIXTURE=/path/big.json.gz npm test`.

Weights: float16 matrices + float32 biases, 1,233,984 bytes (`tools/export_weights.py`).

## Build, test, deploy

```bash
# Python reference (CPU torch)
uv venv .venv --python 3.12            # or python -m venv .venv
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python numpy gymnasium pillow

.venv/bin/python tools/export_weights.py        # web/src/model/gen5.{bin,json}
.venv/bin/python tools/make_parity_fixtures.py  # web/test/fixtures/parity.json.gz
.venv/bin/python tools/training_curves.py       # web/public/data/training-curves.json
.venv/bin/python tools/evaluate.py --games 5000 # web/public/data/evaluation.json
.venv/bin/python tools/optimize_images.py       # card art -> web/src/assets/cards
.venv/bin/python tools/build_bear_atlas.py      # bear frames -> web/src/assets/bear

# Web app
cd web
npm ci
npm test            # vitest: parity replays + engine invariants
npm run typecheck
npm run build       # static site in web/dist
```

**Cloudflare Pages:** root directory `web`, build command `npm run build`, output
directory `dist`. `web/public/_headers` gives `/assets/*` (fingerprinted JS, CSS, fonts,
art and the model binary) a one-year immutable cache and keeps `index.html` revalidated.
Fonts (Inter, Roboto Mono) are self-hosted via `@fontsource`.

Transfer sizes: JS 31 KB gz, CSS 10 KB gz, model 1.23 MB (fetched by the worker at
start-up), card art ~25 KB per card, bear atlas 0.5 MB (lazy).

The Flask + Socket.IO server (`web.py`, `coup/web_agent.py`, legacy client in
`static/`) still runs (`pip install -r requirements_web.txt && python web.py`), but the
new frontend does not use it.

## Data for the portfolio

- `web/public/data/training-curves.json` — win rate vs episode for every generation's
  log, bin-averaged to ~300 points: `{ version, metric, columns: ["episode","winRate",
  "avgLen","entropy"], gen5Training: { episodes, wallClockHours, opponentMix, … },
  generations: [{ id, label, players, obsDim, hiddenDim, plannedEpisodes,
  loggedEpisodes, wallClockHours, opponents, note, finalWinRate, points: [[ep, win%,
  len, ent], …] }] }`.
- `web/public/data/evaluation.json` — Gen5 head-to-head results (below).

## Evaluation

`tools/evaluate.py` plays the deployed Gen5 policy (sampling, fresh LSTM state per game)
against every baseline that still loads, 5,000 games each, seats alternating, every game
seeded. Earlier generations are fed through the encoders they were trained with (loaded
from git history). Win rate with 95% Wilson interval:

| Opponent | Gen5 win rate | 95% CI | Avg turns |
| --- | --- | --- | --- |
| Uniform random | 90.6% | 89.7–91.3 | 9.5 |
| Random zoo profiles | 88.4% | 87.4–89.2 | 7.7 |
| Rule-based heuristic | 91.7% | 90.9–92.5 | 13.3 |
| CFR (MCCFR, 5M iterations) | 84.8% | 83.8–85.8 | 7.6 |
| PPO Gen 1 | 80.7% | 79.6–81.8 | 10.6 |
| PPO Gen 2 | 77.7% | 76.6–78.9 | 9.3 |
| PPO Gen 3 | 42.3% | 40.9–43.7 | 9.2 |
| PPO Gen 4 | 73.3% | 72.1–74.5 | 7.4 |

Gen 3 (pure self-play, 23-dim observation) beats Gen 5 head-to-head; Gen 5 never trained
against it. These are bot-vs-bot numbers only.

## Generations

| Gen | Observation | LSTM | Training | Notes |
| --- | --- | --- | --- | --- |
| 1 | 23 | 64 | 500k episodes vs random zoo profiles | first PPO agent |
| 2 | 23 | 64 | fine-tune vs 50% zoo / 50% heuristic | log covers 96k episodes |
| 3 | 23 | 64 | 1M episodes, 75% self-play / 25% zoo | log not preserved |
| 4 | 35 | 64 | 1M episodes self-play + zoo | adds claimed-card and caught-bluff memory |
| **5** | **70** | **256** | **3.5M episodes, 75% self-play / 15% zoo / 10% heuristic, 34.2 h CPU** | adds last-5-actions history; **deployed** |
| 6 | 155 | 512 | N-player (2–6) self-play, ~626k episodes logged | multi-player experiment |

## Repository map

- `coup/` — Python engine (`game.py`), gym env + encoder (`coup_env.py`), PPO model and
  agents, CFR, training scripts, Flask server agent.
- `versions/` — checkpoints and training logs per generation.
- `tools/` — export, parity fixtures, evaluation, curves, asset builders.
- `web/` — Vite + Preact + TypeScript browser app and its tests.
- `art/djungelskog-pixel/` — source frames for the bear avatar.
- `static/` — the previous Socket.IO frontend (served by `web.py`).
