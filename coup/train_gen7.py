"""
Gen 7 league training.

    .venv/bin/python -m coup.train_gen7 --iterations 1500

Rollouts: each worker process runs many CoupGame instances at once, each inside a
greenlet. Network-backed players switch out of their game when asked for a
decision; the worker batches all pending decisions per model into one forward
pass and resumes the games. The engine is the unmodified coup/game.py.

League (prioritised fictitious self-play): every game the learner faces
- itself (both seats recorded),
- a frozen Gen 7 snapshot from earlier in the run,
- or a fixed opponent: PPO Gen 1-5 with their original encoders, the CFR
  strategy, the heuristic, random zoo profiles or the random agent.
Snapshots and fixed opponents are weighted by (1 - learner win rate)^2, so the
opponents it still struggles with (initially Gen 3) are played most.

Loss: clipped PPO + value + entropy + a belief cross-entropy (opponent's hidden
hand). Advantages use a privileged critic that also sees the opponent's hand
(training only; it is not exported).
"""

import argparse
import json
import math
import os
import random
import time
from collections import defaultdict
from multiprocessing import get_context

import numpy as np
import torch
import torch.nn.functional as F
from greenlet import greenlet, getcurrent

from .game import CoupGame, Card
from .agents import Agent, HeuristicAgent, RandomAgent
from .zoo_agents import ZooAgent
from .cfr_agent import CFRAgent
from .coup_env import RLAction, RL_TO_ACT_TYPE, RL_TO_BLOCK
from . import gen7
from .legacy import load_generation, GENERATIONS, ROOT

OUT_DIR = os.path.join(ROOT, "versions/gen7")
SNAP_DIR = os.path.join(OUT_DIR, "snapshots")
CFR_PATH = os.path.join(ROOT, "versions/gen1-4/strategy_5m.json")
FIXED = ["gen1", "gen2", "gen3", "gen4", "gen5", "cfr", "heuristic", "zoo", "random"]
SCRIPTED = {"cfr", "heuristic", "zoo", "random"}
EXCH_VAL = {Card.DUKE: 5, Card.ASSASSIN: 4, Card.CAPTAIN: 3, Card.AMBASSADOR: 2, Card.CONTESSA: 1}


# -----------------------------------------------------------------------------
# Rollouts
# -----------------------------------------------------------------------------

class Proxy(Agent):
    """Engine-side agent that hands each decision to the batching loop."""

    def __init__(self, seat):
        self.seat = seat
        self.name = f"P{seat}"

    def _ask(self, req, view, ctx):
        return getcurrent().parent.switch((self.seat, req, view, ctx))

    def choose_action(self, view, legal_actions):
        t = RL_TO_ACT_TYPE.get(self._ask('ACT', view, legal_actions))
        for a in legal_actions:
            if a.action_type == t:
                return a
        return legal_actions[0]

    def choose_challenge(self, view, claimer_idx, claimed_card):
        return self._ask('CHL', view, claimed_card) == RLAction.YES

    def choose_counteraction(self, view, actor_idx, action_type, blocking_cards):
        idx = self._ask('CTR', view, {'action': action_type, 'cards': blocking_cards})
        return None if idx == RLAction.NO else RL_TO_BLOCK.get(idx)

    def choose_card_to_lose(self, view):
        return 0 if self._ask('LOSE', view, None) == RLAction.LOSE_CARD_0 else 1

    def choose_exchange_cards(self, view, all_cards, num_to_keep):
        ranked = sorted(range(len(all_cards)), key=lambda i: -EXCH_VAL[all_cards[i]])
        return sorted(ranked[:num_to_keep])


class Seat:
    __slots__ = ("key", "h", "prev", "record", "steps")

    def __init__(self, key, model, record):
        self.key = key
        self.h = model.reset_hidden(1) if model is not None else None
        self.prev = -1
        self.record = record
        self.steps = []


class Slot:
    __slots__ = ("game", "g", "req", "seats", "opp", "learner_seats")


_models = {}
_cfr = None


def get_model(key, path=None):
    """('gen7' | 'legacy', model, env) for a model key; cached per worker."""
    if key in _models:
        return _models[key]
    if key in GENERATIONS:
        model, env = load_generation(key)
        entry = ("legacy", model, env)
    else:
        model = gen7.CoupGen7()
        model.load_state_dict(torch.load(path or key, map_location="cpu"))
        model.eval()
        entry = ("gen7", model, None)
    _models[key] = entry
    return entry


def scripted(key):
    global _cfr
    if key == "heuristic":
        return HeuristicAgent()
    if key == "zoo":
        return ZooAgent.random_profile()
    if key == "random":
        return RandomAgent()
    if key == "cfr":
        if _cfr is None:
            _cfr = CFRAgent.from_file(CFR_PATH)
        return _cfr
    raise KeyError(key)


def new_slot(opp_keys, opp_probs, learner):
    s = Slot()
    opp = random.choices(opp_keys, weights=opp_probs)[0]
    s.opp = opp
    ls = random.randint(0, 1)
    seats = [None, None]
    agents = [None, None]
    seats[ls] = Seat("learner", learner, True)
    agents[ls] = Proxy(ls)
    os_ = 1 - ls
    if opp == "mirror":
        seats[os_] = Seat("learner", learner, True)
        agents[os_] = Proxy(os_)
    elif opp in SCRIPTED:
        agents[os_] = scripted(opp)
    else:
        seats[os_] = Seat(opp, get_model(opp)[1], False)
        agents[os_] = Proxy(os_)
    s.seats = seats
    s.learner_seats = [i for i in (0, 1) if seats[i] is not None and seats[i].record]
    s.game = CoupGame(agents, num_players=2)
    s.g = greenlet(lambda: ("DONE", s.game.play_game()))
    s.req = s.g.switch()
    return s


def _forward(kind, model, env, items):
    """items: list of (slot, seat, req, view, ctx). Returns per-item extras."""
    n = len(items)
    obs, masks, bmasks = [], [], []
    for slot, seat, req, view, ctx in items:
        st = slot.seats[seat]
        if kind == "gen7":
            o, m, bm = gen7.encode(req, view, ctx, st.prev)
            bmasks.append(bm)
        else:
            o, m = env._encode_state({'req_type': req, 'view': view, 'context': ctx})
        obs.append(o)
        masks.append(m)
    x = torch.from_numpy(np.stack(obs)).unsqueeze(1)
    h = torch.cat([it[0].seats[it[1]].h[0] for it in items], 1)
    c = torch.cat([it[0].seats[it[1]].h[1] for it in items], 1)
    with torch.no_grad():
        if kind == "gen7":
            logits, _, _, _, (h2, c2) = model(x, (h, c))
        else:
            logits, _, (h2, c2) = model(x, (h, c))
        logits = logits.squeeze(1)
        mt = torch.from_numpy(np.stack(masks))
        logits = logits.masked_fill(~mt, -1e9)
        logp_all = F.log_softmax(logits, -1)
        acts = torch.multinomial(logp_all.exp(), 1).squeeze(1)
        logp = logp_all.gather(1, acts.unsqueeze(1)).squeeze(1)
    for i, (slot, seat, req, view, ctx) in enumerate(items):
        st = slot.seats[seat]
        st.h = (h2[:, i:i + 1].clone(), c2[:, i:i + 1].clone())
        a = int(acts[i])
        if st.record:
            opp_cards = slot.game.state.players[1 - seat].cards
            st.steps.append((obs[i], masks[i], bmasks[i], a, float(logp[i]),
                             gen7.hand_class(opp_cards) if opp_cards else -1,
                             gen7.opp_hand_feature(opp_cards)))
        st.prev = a
    return acts.tolist()


def rollout_task(task):
    torch.set_num_threads(1)
    random.seed(task["seed"])
    np.random.seed(task["seed"] % 2**32)
    torch.manual_seed(task["seed"])
    for k in [k for k in _models if k == "learner"]:
        del _models[k]
    learner = gen7.CoupGen7()
    learner.load_state_dict(torch.load(task["learner_path"], map_location="cpu"))
    learner.eval()
    _models["learner"] = ("gen7", learner, None)
    for k in task["opp_keys"]:
        if k not in SCRIPTED and k != "mirror":
            get_model(k)

    keys, probs = task["opp_keys"], task["opp_probs"]
    to_start = task["games"]
    active = []
    for _ in range(min(task["slots"], to_start)):
        active.append(new_slot(keys, probs, learner))
        to_start -= 1

    episodes = []
    results = defaultdict(lambda: [0, 0, 0])  # opp -> [learner wins, games, draws]
    while active:
        groups = defaultdict(list)
        for slot in active:
            seat, req, view, ctx = slot.req
            groups[slot.seats[seat].key].append((slot, seat, req, view, ctx))
        nxt = []
        for key, items in groups.items():
            kind, model, env = get_model(key)
            acts = _forward(kind, model, env, items)
            for (slot, *_), a in zip(items, acts):
                slot.req = slot.g.switch(a)
        for slot in active:
            if slot.req[0] != "DONE":
                nxt.append(slot)
                continue
            winner = slot.req[1]
            for ls in slot.learner_seats:
                st = slot.seats[ls]
                r = 0.0 if winner is None else (1.0 if winner == ls else -1.0)
                if st.steps:
                    episodes.append((st.steps, r))
            if slot.opp != "mirror":
                ls = slot.learner_seats[0]
                res = results[slot.opp]
                res[0] += int(winner == ls)
                res[1] += 1
                res[2] += int(winner is None)
            if to_start > 0:
                nxt.append(new_slot(keys, probs, learner))
                to_start -= 1
        active = nxt

    # pack
    lens = np.array([len(s) for s, _ in episodes], dtype=np.int32)
    flat = [st for s, _ in episodes for st in s]
    return dict(
        lens=lens,
        rewards=np.array([r for _, r in episodes], dtype=np.float32),
        obs=np.stack([f[0] for f in flat]).astype(np.float32),
        mask=np.stack([f[1] for f in flat]),
        bmask=np.stack([f[2] for f in flat]),
        act=np.array([f[3] for f in flat], dtype=np.int64),
        logp=np.array([f[4] for f in flat], dtype=np.float32),
        bel=np.array([f[5] for f in flat], dtype=np.int64),
        opph=np.stack([f[6] for f in flat]).astype(np.float32),
        results=dict(results),
    )


# -----------------------------------------------------------------------------
# PPO update
# -----------------------------------------------------------------------------

def merge(parts):
    out = {k: np.concatenate([p[k] for p in parts]) for k in
           ("lens", "rewards", "obs", "mask", "bmask", "act", "logp", "bel", "opph")}
    res = defaultdict(lambda: [0, 0, 0])
    for p in parts:
        for k, v in p["results"].items():
            for i in range(3):
                res[k][i] += v[i]
    out["results"] = dict(res)
    return out


def make_batches(data, ep_ids, offsets):
    """Padded (B, T, ...) tensors for a list of episode ids."""
    lens = data["lens"][ep_ids]
    T = int(lens.max())
    B = len(ep_ids)
    idx = np.zeros((B, T), dtype=np.int64)
    valid = np.zeros((B, T), dtype=bool)
    for b, e in enumerate(ep_ids):
        L = data["lens"][e]
        idx[b, :L] = np.arange(offsets[e], offsets[e] + L)
        valid[b, :L] = True
    t = {k: torch.from_numpy(data[k][idx]) for k in ("obs", "mask", "bmask", "act", "logp", "bel", "opph")}
    t["valid"] = torch.from_numpy(valid)
    t["idx"] = idx
    return t


def ppo_update(model, opt, data, cfg):
    lens = data["lens"]
    E = len(lens)
    offsets = np.concatenate([[0], np.cumsum(lens)[:-1]])
    order = np.argsort(lens, kind="stable")
    chunks = [order[i:i + cfg.minibatch] for i in range(0, E, cfg.minibatch)]
    N = int(lens.sum())

    # values with current weights -> GAE (gamma = 1, terminal reward only)
    vpriv = np.zeros(N, dtype=np.float32)
    model.eval()
    with torch.no_grad():
        for ch in chunks:
            b = make_batches(data, ch, offsets)
            _, _, _, out, _ = model(b["obs"])
            vp = model.priv_value(out, b["opph"])
            vpriv[b["idx"][b["valid"].numpy()]] = vp[b["valid"]].numpy()
    adv = np.zeros(N, dtype=np.float32)
    ret = np.zeros(N, dtype=np.float32)
    for e in range(E):
        s, L = offsets[e], lens[e]
        v = vpriv[s:s + L]
        gae = 0.0
        nxt = 0.0
        for t in range(L - 1, -1, -1):
            r = data["rewards"][e] if t == L - 1 else 0.0
            delta = r + nxt - v[t]
            gae = delta + cfg.lam * gae
            adv[s + t] = gae
            ret[s + t] = gae + v[t]
            nxt = v[t]
    adv_n = (adv - adv.mean()) / (adv.std() + 1e-8)
    adv_t = torch.from_numpy(adv_n)
    ret_t = torch.from_numpy(ret)

    model.train()
    stats = defaultdict(list)
    for epoch in range(cfg.epochs):
        random.shuffle(chunks)
        kls = []
        for ch in chunks:
            b = make_batches(data, ch, offsets)
            valid = b["valid"]
            flat_idx = torch.from_numpy(b["idx"])[valid]
            logits, value, blog, out, _ = model(b["obs"])
            logits = logits.masked_fill(~b["mask"], -1e9)[valid]
            logp_all = F.log_softmax(logits, -1)
            act = b["act"][valid]
            logp = logp_all.gather(1, act.unsqueeze(1)).squeeze(1)
            ent = -(logp_all.exp() * logp_all).sum(-1)
            # entropy only over legal actions; single-option prompts contribute 0
            ratio = torch.exp(logp - b["logp"][valid])
            a = adv_t[flat_idx]
            pg = -torch.min(ratio * a, ratio.clamp(1 - cfg.clip, 1 + cfg.clip) * a).mean()
            r = ret_t[flat_idx]
            vloss = F.mse_loss(value[valid], r)
            vp = model.priv_value(out, b["opph"])[valid]
            vploss = F.mse_loss(vp, r)
            bl = b["bel"][valid]
            bm = b["bmask"][valid]
            ok = bl >= 0
            blog_m = gen7.masked_belief(blog[valid][ok], bm[ok])
            bloss = F.cross_entropy(blog_m, bl[ok])
            loss = (pg + cfg.vf * (vloss + vploss) - cfg.ent * ent.mean() + cfg.belief * bloss)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            opt.step()
            with torch.no_grad():
                kl = (b["logp"][valid] - logp).mean().item()
                kls.append(kl)
                bacc = (blog_m.argmax(-1) == bl[ok]).float().mean().item()
            for k, v in (("pg", pg.item()), ("v", vloss.item()), ("vp", vploss.item()),
                         ("ent", ent.mean().item()), ("bel", bloss.item()), ("bacc", bacc), ("kl", kl)):
                stats[k].append(v)
        if np.mean(kls) > cfg.target_kl:
            break
    out = {k: float(np.mean(v)) for k, v in stats.items()}
    out["epochs"] = epoch + 1
    return out


# -----------------------------------------------------------------------------
# League bookkeeping
# -----------------------------------------------------------------------------

def pfsp_weight(p):
    return (1.0 - p) ** 2 + 0.02


def opponent_distribution(ema, snaps, cfg):
    keys, probs = ["mirror"], [cfg.p_mirror]
    if snaps:
        w = np.array([pfsp_weight(ema.get(s, 0.5)) for s in snaps])
        keys += snaps
        probs += list(cfg.p_snap * w / w.sum())
    fixed_share = 1.0 - cfg.p_mirror - (cfg.p_snap if snaps else 0.0)
    w = np.array([pfsp_weight(ema.get(k, 0.5)) for k in FIXED])
    keys += FIXED
    probs += list(fixed_share * w / w.sum())
    return keys, [float(p) for p in probs]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations", type=int, default=1500)
    ap.add_argument("--games", type=int, default=12000, help="games per iteration")
    ap.add_argument("--workers", type=int, default=15)
    ap.add_argument("--slots", type=int, default=64, help="concurrent games per worker")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--lr-end", type=float, default=3e-5)
    ap.add_argument("--ent", type=float, default=0.02)
    ap.add_argument("--ent-end", type=float, default=0.004)
    ap.add_argument("--vf", type=float, default=0.5)
    ap.add_argument("--belief", type=float, default=0.25)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--lam", type=float, default=0.95)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--minibatch", type=int, default=512, help="episodes per minibatch")
    ap.add_argument("--target-kl", type=float, default=0.03)
    ap.add_argument("--p-mirror", type=float, default=0.35)
    ap.add_argument("--p-snap", type=float, default=0.2)
    ap.add_argument("--snap-every", type=int, default=20)
    ap.add_argument("--max-snaps", type=int, default=16)
    ap.add_argument("--save-every", type=int, default=10)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--threads", type=int, default=4)
    cfg = ap.parse_args()

    os.makedirs(SNAP_DIR, exist_ok=True)
    torch.manual_seed(cfg.seed)
    random.seed(cfg.seed)
    # 4 learner threads are as fast as 8 here and far less sensitive to other load
    torch.set_num_threads(cfg.threads)
    model = gen7.CoupGen7()
    opt = torch.optim.Adam(model.parameters(), lr=cfg.lr, eps=1e-5)
    state_path = os.path.join(OUT_DIR, "train_state.pt")
    learner_path = os.path.join(OUT_DIR, "learner_current.pt")
    log_txt = os.path.join(OUT_DIR, "training_log_gen7.txt")
    log_jsonl = os.path.join(OUT_DIR, "training_log_gen7.jsonl")
    it0, episodes, games, wall0, ema, snaps = 0, 0, 0, 0.0, {}, []
    if cfg.resume and os.path.exists(state_path):
        st = torch.load(state_path, map_location="cpu", weights_only=False)
        model.load_state_dict(st["model"])
        opt.load_state_dict(st["opt"])
        it0, episodes, games, wall0 = st["it"], st["episodes"], st["games"], st["wall"]
        ema, snaps = st["ema"], st["snaps"]
        print(f"resumed at iteration {it0}")
    else:
        with open(log_txt, "w") as f:
            f.write(f"Gen 7 league training: {json.dumps(vars(cfg))}\n")
        open(log_jsonl, "w").close()

    ctx = get_context("fork")
    pool = ctx.Pool(cfg.workers)
    t_start = time.time() - wall0
    for it in range(it0, cfg.iterations):
        frac = it / max(1, cfg.iterations - 1)
        lr = cfg.lr + (cfg.lr_end - cfg.lr) * frac
        cfg_ent = cfg.ent + (cfg.ent_end - cfg.ent) * frac
        for g in opt.param_groups:
            g["lr"] = lr
        torch.save(model.state_dict(), learner_path)
        keys, probs = opponent_distribution(ema, snaps, cfg)
        per = cfg.games // cfg.workers
        tasks = [dict(seed=cfg.seed * 1_000_003 + it * 1000 + w, learner_path=learner_path,
                      opp_keys=keys, opp_probs=probs, games=per, slots=cfg.slots)
                 for w in range(cfg.workers)]
        t0 = time.time()
        data = merge(pool.map(rollout_task, tasks))
        t_roll = time.time() - t0

        class C:  # per-iteration config view
            pass
        c = C()
        c.__dict__.update(vars(cfg))
        c.ent = cfg_ent
        t1 = time.time()
        st = ppo_update(model, opt, data, c)
        t_upd = time.time() - t1

        episodes += len(data["lens"])
        games += cfg.workers * per
        wr = {}
        for k, (w, n, d) in data["results"].items():
            if n == 0:
                continue
            wr[k] = (w, n)
            a = min(1.0, n / 200.0) * 0.3
            ema[k] = (1 - a) * ema.get(k, 0.5) + a * (w / n)
        elapsed = time.time() - t_start
        fixed_str = " ".join(f"{k}:{100 * wr[k][0] / wr[k][1]:.0f}" for k in FIXED if k in wr)
        snap_wr = [wr[s] for s in snaps if s in wr]
        snap_str = (f"{100 * sum(w for w, _ in snap_wr) / max(1, sum(n for _, n in snap_wr)):.0f}"
                    if snap_wr else "-")
        line = (f"It {it + 1:5d} | Ep {episodes:9d} | Games {games:9d} | {fixed_str} | snaps:{snap_str} | "
                f"Ent {st['ent']:.3f} | KL {st['kl']:.4f} | V {st['v']:.3f} | Vp {st['vp']:.3f} | "
                f"Bel {st['bel']:.3f} ({100 * st['bacc']:.0f}%) | roll {t_roll:.0f}s upd {t_upd:.0f}s | "
                f"T {elapsed / 3600:.2f}h")
        print(line, flush=True)
        with open(log_txt, "a") as f:
            f.write(line + "\n")
        with open(log_jsonl, "a") as f:
            f.write(json.dumps(dict(it=it + 1, episodes=episodes, games=games, hours=elapsed / 3600,
                                    lr=lr, entCoef=cfg_ent, stats=st,
                                    results={k: [w, n] for k, (w, n) in wr.items()},
                                    ema={k: round(v, 4) for k, v in ema.items()},
                                    steps=int(data["lens"].sum()))) + "\n")

        if (it + 1) % cfg.snap_every == 0:
            p = os.path.join(SNAP_DIR, f"snap_{it + 1:05d}.pt")
            torch.save(model.state_dict(), p)
            snaps.append(p)
            ema[p] = 0.5
            if len(snaps) > cfg.max_snaps:
                old = snaps.pop(0)
                ema.pop(old, None)
        if (it + 1) % cfg.save_every == 0 or it + 1 == cfg.iterations:
            torch.save(model.state_dict(), os.path.join(OUT_DIR, "ppo_model_gen7.pt"))
            torch.save(dict(model=model.state_dict(), opt=opt.state_dict(), it=it + 1, episodes=episodes,
                            games=games, wall=time.time() - t_start, ema=ema, snaps=snaps),
                       state_path)
    pool.close()


if __name__ == "__main__":
    main()
