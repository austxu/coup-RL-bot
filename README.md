# Coup CFR

CFR (Counterfactual Regret Minimization) implementation for the game Coup.

## How to Run on Windows

This project is a Python package. To avoid `ImportError`, you must run it from this root directory using the `-m` flag.

### Run a Simulation

You can use the provided batch file:
```cmd
run_simulation.bat
```

Or run manually:
```bash
python -m coup.simulate --games 100
```

### Train the CFR Agent

```bash
python -m coup.train_cfr --iterations 100000 --output strategy.json
```

### Options

For more options, use the `--help` flag on any module:
```bash
python -m coup.simulate --help
python -m coup.train_cfr --help
```
