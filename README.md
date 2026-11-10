# Coup RL Bot

A 1v1 [Coup](https://en.wikipedia.org/wiki/Coup_(card_game)) bot trained with PPO and an
LSTM memory, plus a browser demo at **https://coup.austxu.dev** where the whole game —
engine and neural network — runs client-side. No backend, no cold starts.

The deployed bot is **Gen 7**: league-trained against every earlier generation, with a
belief head that predicts the opponent's hidden hand. It beats every earlier generation
and every scripted baseline head-to-head ([Evaluation](#evaluation)).

## How the demo works

```
            main thread                                   Web Worker
 ┌──────────────────────────────────────┐     ┌──────────────────────────────┐
 │ engine/game.ts   port of coup/game.py │     │ bot/model.ts                 │
 │   generator: yields each Prompt       │     │   fc1→relu→fc2→relu→LSTM(256)│
 │ engine/encode7.ts 127-dim obs + masks │──►  │   → actor logits, tanh critic│
 │   (encode.ts: Gen 5's 70-dim obs)     │ obs │   → belief logits (Gen 7)    │
 │ game/match.ts    paces events into    │ ◄── │   masked softmax, sampled    │
 │   animated beats, asks human or bot,  │π,v,b│   one LSTM state per seat    │
 │   records replay frames               │     │ model/gen7.bin (1.27 MB)     │
 │ ui/*.tsx         Preact table + mind  │     │ model/gen5.bin (lazy)        │
 └──────────────────────────────────────┘     └──────────────────────────────┘
```

- `web/src/engine/game.ts` is a line-for-line port of `CoupGame`. Every agent call in
  Python is a `yield` of a prompt, so the order of prompts, state changes and shuffles
  is identical (challenge before block, block challenges routed through
  `choose_challenge`, lose-influence prompts only with two cards, forced Coup at 10+).
- `web/src/engine/encode7.ts` ports `coup/gen7.py` (observation, action mask, belief
  mask); `web/src/engine/encode.ts` ports Gen 5's `CoupEnv._encode_state`. Both bots
  use the same fixed exchange heuristic.
- `web/src/bot/` loads the weights in a Web Worker (Gen 7 at start-up, Gen 5 only when
  picked), keeps a separate LSTM state per seat for the whole game (like
  `PPOAgent.hidden_state`), and samples from the masked softmax — the same mixed
  strategy as production, not argmax. The UI adds a 0.5–1.1 s "thinking" delay so it
  feels human.
- The **bot's mind** panel shows, after every bot decision, its probability over the
  options it actually had and the critic's win estimate `(v+1)/2` as a sparkline. It
  never shows the bot's hidden cards during play.
- **Guessing your hand** (Gen 7 only) shows the belief head's output after each bot
  decision. The bot never sees your cards; it infers them from the public game, and the
  true hand is only used as a training label. It shows P(you hold at least one) for
  each role, the change since the last decision, and its two most likely exact hands. Impossible hands are masked out by
  card counting (three copies per role, minus the bot's own cards and everything
  revealed). Your own cards are marked so you can see when it's right.
- After the game, **Review** steps through every decision with both hands visible,
  bluff / challenge flags, the bot's policy and its belief at each point, plus a
  role-by-decision heatmap of the belief against the true hand.
- The table is CSS 3D: lit cards that tilt under the pointer and flip on reveal,
  coins tossed on ballistic arcs into stacks, and a showdown spotlight for challenges
  (with a table shake when a bluff is caught). Nothing needs WebGL. Optional sound is
  synthesised with Web Audio; it is off by default and never plays in the embed.
- Teddy, the bot's avatar, is the Djungelskog pixel bear (`art/djungelskog-pixel`, the author's
  own animation frames), packed into one lazy-loaded WebP atlas.

### URL parameters

| Param | Effect |
| --- | --- |
| `?embed=1` | Hides page chrome; layout fits a ~16:10 iframe (`embed=portfolio` still works). |
| `?embed=1&autoplay=1` | Attract mode: Gen 7 plays itself (both hands shown, slowed down) in a loop until the visitor clicks **Play the bot**. |

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

**Gen 7** has its own fixture (`web/test/fixtures/parity7.json.gz`, from
`make_parity_fixtures.py --model gen7`): Gen 7 vs random, zoo, heuristic, Gen 5 and
itself. Besides everything above, each Gen 7 decision records the belief mask, the
previous decision fed back in, and belief logits from both weight sets;
`web/test/parity7.test.ts` asserts the same engine and encoder equality, network vs float16 within 1e-4
(measured: max |Δlogit| 4.8e-6, |Δvalue| 9.4e-7, |Δbelief logit| 2.1e-6) and float16 vs
float32 within quantisation noise (max policy TV 1.0e-3, belief TV 7.0e-4, same argmax in
all 1,314 Gen 7 decisions of 100 games).

## Build, test, deploy

```bash
# Python reference (CPU torch)
uv venv .venv --python 3.12            # or python -m venv .venv
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python numpy gymnasium pillow

uv pip install --python .venv/bin/python greenlet   # Gen 7 trainer only

# Gen 7: league PPO, 1,000 updates x 12,000 games (~7.7 h on a 16-thread CPU)
.venv/bin/python -m coup.train_gen7 --iterations 1000 --workers 15 --threads 4
#   writes versions/gen7/{ppo_model_gen7.pt,training_log_gen7.txt,.jsonl}; --resume continues

.venv/bin/python tools/export_weights.py        # web/src/model/gen5.{bin,json}
.venv/bin/python tools/export_weights.py --model gen7 --checkpoint versions/gen7/ppo_model_gen7.pt
.venv/bin/python tools/make_parity_fixtures.py  # web/test/fixtures/parity.json.gz
.venv/bin/python tools/make_parity_fixtures.py --model gen7 --checkpoint versions/gen7/ppo_model_gen7.pt
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

Transfer sizes: JS 38 KB gz, CSS 13 KB gz, Gen 7 model 1.27 MB (fetched by the worker at
start-up; Gen 5's 1.23 MB only when picked), card art ~25 KB per card, bear atlas 0.5 MB
(lazy).

The Flask + Socket.IO server (`web.py`, `coup/web_agent.py`, legacy client in
`static/`) still runs (`pip install -r requirements_web.txt && python web.py`), but the
new frontend does not use it.

## Data for the portfolio

- `web/public/data/training-curves.json` — win rate vs episode for every generation's
  log, bin-averaged to ~300 points: `{ version, metric, columns: ["episode","winRate",
  "avgLen","entropy"], deployed: "gen7", gen5Training: { … }, gen7Training: { episodes,
  games, ppoUpdates, wallClockHours, gamesPerUpdate, opponentMix, fixedPool,
  prioritisation, snapshotEveryUpdates }, generations: [{ id, label, players, obsDim,
  hiddenDim, plannedEpisodes, loggedEpisodes, wallClockHours, opponents, note,
  finalWinRate, points: [[ep, win%, len, ent], …] }] }`. Gen 7's `winRate` excludes
  mirror self-play games (always 50%); its entry also has `gamesPlayed`, `iterations`
  and `opponentCurves: { gen1 … gen5, cfr, heuristic, zoo, random, snapshots: [[ep,
  win%], …] }`, the learner's training win rate split by opponent.
- `web/public/data/evaluation.json` — head-to-head results (below): `{ asOf, model,
  policy, engine, metric, games, gamesPerOpponent, opponents: [Gen 7 rows], models: [{
  id: "gen7" | "gen5", description, opponents: [{ id, label, games, wins, winRate,
  ci95, avgTurns }] }], belief: { description, metrics, pooled: { decisions, logLoss,
  priorLogLoss, top1, priorTop1, roleBrier, priorRoleBrier, reliability: [{ lo, hi,
  predicted, observed, n }] }, byOpponent: { … } } }`. Top-level `opponents` keeps the
  old single-model shape.

## Evaluation

`tools/evaluate.py` plays the deployed Gen 7 policy and the previous Gen 5 policy
(sampling, fresh LSTM state per game) against every baseline that still loads,
5,000 games each, seats alternating, every game seeded. Earlier generations are fed
through the encoders they were trained with (loaded from git history). Win rate with
95% Wilson interval:

| Opponent | Gen 7 win rate | 95% CI | Avg turns | Gen 5 win rate | 95% CI |
| --- | --- | --- | --- | --- | --- |
| Uniform random | **92.6%** | 91.8–93.3 | 9.9 | 90.6% | 89.8–91.4 |
| Random zoo profiles | **86.7%** | 85.7–87.6 | 7.5 | 88.4% | 87.4–89.2 |
| Rule-based heuristic | **89.1%** | 88.2–90.0 | 14.4 | 91.7% | 90.9–92.5 |
| CFR (MCCFR, 5M iterations) | **87.3%** | 86.4–88.2 | 7.8 | 84.8% | 83.8–85.8 |
| PPO Gen 1 | **85.4%** | 84.4–86.4 | 11.3 | 80.7% | 79.6–81.8 |
| PPO Gen 2 | **85.4%** | 84.4–86.3 | 10.2 | 77.7% | 76.5–78.8 |
| PPO Gen 3 | **72.3%** | 71.0–73.5 | 8.2 | 42.3% | 40.9–43.6 |
| PPO Gen 4 | **78.7%** | 77.5–79.8 | 7.1 | 73.3% | 72.0–74.5 |
| PPO Gen 5 | **79.7%** | 78.6–80.8 | 9.3 | — | — |

Gen 7 beats every earlier generation, and its 95% interval sits above Gen 5's
against random, CFR and Gens 1–4. The biggest change is against Gen 3, which Gen 5
lost to (42.3%) and Gen 7 beats 72.3% of the time. Head-to-head, Gen 7 beats Gen 5 in
79.7% of games.

**Where it is still weaker:** Gen 5 exploits two of the scripted bots harder than
Gen 7 does: the rule-based heuristic (91.7% vs 89.1%) and the random zoo profiles
(88.4% vs 86.7%), both outside each other's intervals. Gen 5 spent 25% of its training
on those two. In the league they were a small share of Gen 7's games once it beat them
more than ~85% of the time, because opponents are weighted by how often it still loses.
These are bot-vs-bot numbers only; humans play differently.

**Belief head.** Over 499,482 Gen 7 decisions in those games, scored against the true
hidden hand, compared with a card-counting prior (every hand still possible, weighted by
how many ways it can be dealt from the unseen cards):

| | Gen 7 belief | Card counting alone |
| --- | --- | --- |
| Exact hand is the top guess | **46.4%** | 20.4% |
| Log loss over hands (lower is better) | **1.505** | 2.127 |
| Brier score, P(holds each role) | **0.135** | 0.197 |

## Why Gen 7 is stronger

- **League training instead of self-play.** Each update plays 12,000 games: 35%
  mirror self-play, 20% against frozen Gen 7 snapshots (one every 20 updates, 16 kept)
  and 45% against a fixed pool — Gens 1–5 through their original encoders, CFR, the
  heuristic, the zoo profiles and random. Opponents are sampled by prioritised
  fictitious self-play, weight `(1 − winrate)² + 0.02`, so the pool keeps pushing on
  whatever it still loses to. Gen 5 never saw Gen 3, which is why it lost to it.
- **A belief head.** A 20-way softmax over the opponent's possible hidden hands (15
  two-card hands, 5 single cards), trained with cross-entropy against the true hand
  and masked by card counting. It shapes the LSTM state towards what matters and is
  what the "Guessing your hand" panel shows.
- **A privileged critic** that also sees the opponent's hand is used only to compute
  advantages during training (lower-variance targets); it is not exported.
- **A fuller observation** (127 dims): the bot's cards per slot, so it knows *which*
  card it gives up (Gen 5 chose blind), coin thresholds, revealed and unseen counts,
  claimed and caught-bluff memory for both players, what a counter-action is
  blocking, its own previous decision, and the last four actions.
- **Throughput.** Games run as greenlets and every pending bot decision is batched
  into one LSTM forward pass: over 1,000 games/s on a shared CPU against Gen 5's 28, so 12M games
  took 7.7 h instead of 3.5M in 34 h.

## Generations

| Gen | Observation | LSTM | Training | Notes |
| --- | --- | --- | --- | --- |
| 1 | 23 | 64 | 500k episodes vs random zoo profiles | first PPO agent |
| 2 | 23 | 64 | fine-tune vs 50% zoo / 50% heuristic | log covers 96k episodes |
| 3 | 23 | 64 | 1M episodes, 75% self-play / 25% zoo | log not preserved |
| 4 | 35 | 64 | 1M episodes self-play + zoo | adds claimed-card and caught-bluff memory |
| 5 | 70 | 256 | 3.5M episodes, 75% self-play / 15% zoo / 10% heuristic, 34.2 h CPU | adds last-5-actions history; previous default |
| 6 | 155 | 512 | N-player (2–6) self-play, ~626k episodes logged | multi-player experiment |
| **7** | **127** | **256** | **12M games, league PPO (self-play, snapshots, Gens 1–5, CFR, scripted), 7.7 h CPU** | **belief head, privileged critic; deployed** |

## Repository map

- `coup/` — Python engine (`game.py`), gym env + encoder (`coup_env.py`), PPO model and
  agents, CFR, training scripts, Flask server agent.
- `versions/` — checkpoints and training logs per generation.
- `tools/` — export, parity fixtures, evaluation, curves, asset builders.
- `web/` — Vite + Preact + TypeScript browser app and its tests.
- `art/djungelskog-pixel/` — source frames for the bear avatar.
- `static/` — the previous Socket.IO frontend (served by `web.py`).
