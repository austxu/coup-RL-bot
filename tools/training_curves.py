"""
Summarise the PPO training logs into web/public/data/training-curves.json
(win rate vs episode per generation, bin-averaged to ~300 points).

    .venv/bin/python tools/training_curves.py
"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web/public/data/training-curves.json")
TARGET_POINTS = 300
LINE = re.compile(r"^Ep\s+(\d+) \| WinRT:\s*([\d.]+)% \| AvgLen:\s*([\d.]+) \|.*Ent:\s*([\d.]+) \| Time:\s*([\d.]+)s")

GENERATIONS = [
    dict(id="gen1", label="Gen 1", log="versions/gen1-4/ppo_gen1_train.log", players="2",
         obsDim=23, hiddenDim=64, plannedEpisodes=500_000,
         opponents="Randomised scripted 'zoo' profiles", completeLog=True,
         note="First PPO + LSTM agent."),
    dict(id="gen2", label="Gen 2", log="versions/gen1-4/ppo_gen2_train.log", players="2",
         obsDim=23, hiddenDim=64, plannedEpisodes=200_000,
         opponents="50% zoo profiles, 50% rule-based heuristic",
         note="Fine-tuned from Gen 1."),
    dict(id="gen3", label="Gen 3", log=None, players="2",
         obsDim=23, hiddenDim=64, plannedEpisodes=1_000_000,
         opponents="75% self-play snapshot, 25% zoo",
         note="Self-play; training log was not preserved."),
    dict(id="gen4", label="Gen 4", log="versions/gen1-4/ppo_gen4_train.log", players="2",
         obsDim=35, hiddenDim=64, plannedEpisodes=1_000_000,
         opponents="Self-play snapshot + zoo",
         note="Adds explicit claim / caught-bluff memory. Only a log excerpt survives."),
    dict(id="gen5", label="Gen 5", log="versions/gen5/training_log_gen5.txt", players="2",
         obsDim=70, hiddenDim=256, plannedEpisodes=3_500_000,
         opponents="75% self-play snapshot, 15% zoo, 10% heuristic", completeLog=True,
         opponentMix={"selfPlaySnapshot": 0.75, "randomZoo": 0.15, "heuristic": 0.10},
         note="Adds the last-5-actions history; the bot in this demo."),
    dict(id="gen6", label="Gen 6", log="versions/gen6/training_log_gen6.txt", players="2-6",
         obsDim=155, hiddenDim=512, plannedEpisodes=2_000_000,
         opponents="N-player self-play + zoo", completeLog=True,
         note="N-player experiment; win rate is per table (chance is 1/N). Final run only."),
]


def parse(path):
    """Rows (episode, winRate, avgLen, entropy) of the last run in the file."""
    runs, rows, last = [], [], -1
    with open(path) as f:
        for line in f:
            m = LINE.match(line)
            if not m:
                continue
            ep = int(m.group(1))
            if ep < last:  # the log was restarted: keep the newest run
                runs.append(rows)
                rows = []
            rows.append((ep, float(m.group(2)), float(m.group(3)), float(m.group(4)), float(m.group(5))))
            last = ep
    runs.append(rows)
    return runs[-1]


def downsample(rows, n):
    if len(rows) <= n:
        return [list(r) for r in rows]
    out = []
    size = len(rows) / n
    for b in range(n):
        chunk = rows[int(b * size):int((b + 1) * size)]
        out.append([
            chunk[-1][0],
            round(sum(r[1] for r in chunk) / len(chunk), 2),
            round(sum(r[2] for r in chunk) / len(chunk), 2),
            round(sum(r[3] for r in chunk) / len(chunk), 3),
        ])
    return out


def main():
    gens = []
    for g in GENERATIONS:
        g = dict(g)
        rows = parse(os.path.join(ROOT, g["log"])) if g["log"] else []
        g["loggedEpisodes"] = rows[-1][0] if rows else None
        g["rawPoints"] = len(rows)
        g["finalWinRate"] = round(sum(r[1] for r in rows[-50:]) / len(rows[-50:]), 2) if rows else None
        # wall clock only where the log covers the whole run from episode 0
        g["wallClockHours"] = round(rows[-1][4] / 3600, 2) if rows and g.get("completeLog") else None
        g.pop("completeLog", None)
        g["points"] = downsample([r[:4] for r in rows], TARGET_POINTS)
        gens.append(g)

    g5 = next(g for g in gens if g["id"] == "gen5")
    payload = {
        "version": 1,
        "description": "PPO training win rate per generation, parsed from the raw training logs.",
        "metric": "winRate is the % of games won in each logged rollout batch against that generation's "
                  "training-opponent mix (bin-averaged). Self-play generations hover near 50% by design.",
        "columns": ["episode", "winRate", "avgLen", "entropy"],
        "deployed": "gen5",
        "gen5Training": {
            "episodes": g5["loggedEpisodes"],
            "wallClockHours": g5["wallClockHours"],
            "device": "cpu",
            "opponentMix": g5["opponentMix"],
            "source": "coup/train_gen5.py (SelfPlayZoo), versions/gen5/training_log_gen5.txt",
            "selfPlaySnapshotEveryEpisodes": 2000,
            "episodesPerPpoUpdate": 200,
        },
        "generations": gens,
    }
    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT):,} bytes)")
    for g in gens:
        print(f"  {g['id']}: {g['rawPoints']} rows -> {len(g['points'])} pts, last ep {g['loggedEpisodes']}, "
              f"final {g['finalWinRate']}, {g['wallClockHours']} h")


if __name__ == "__main__":
    main()
