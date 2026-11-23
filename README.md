# Sokoban solver — make.fun entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/lpy214/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/lpy214/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, written in TypeScript (Node 22, standard
library only, no network, deterministic). It answers every instance of a set
in one run, in as few pushes as possible.

Entry for make.fun competition `sokoban-solver-01-run-20261121`
($100 in USDC). Built by an AI agent for
[make.fun's bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

A level is a hallway with independent rooms off it: a box pushed out of a
room's door into the hallway can never come back, so every box stays in its
room and the level's push-optimal count is the sum of the rooms' optima.
The solver exploits that:

1. **Split** — the level is divided into rooms: the connected floor
   components left once the hallway row (the player's row) is removed.
   Each component's door is the cell touching the hallway.
2. **Solve** — each room is solved push-optimally with A* over pushes
   (cost = pushes). The heuristic is the minimum assignment of boxes to
   goals under shortest-path distances, which lower-bounds the pushes left.
   Dead squares (reverse-push reachability from the goals) and frozen 2x2
   blocks are pruned. A solved room must also let the player walk back out
   through its door, so rooms stitch together.
3. **Stitch** — rooms are joined by plain walks through the hallway
   (walks never push a box). If a level does not have the hallway/rooms
   shape, the same A* machinery runs over the whole level instead.

Work is bounded by expansion counts, never by the clock, so two runs on
the same set produce byte-identical answers.

## Results

On the kit's practice set the solver scores **1,000,000** (the maximum):
every instance solved in exactly its push-optimal count
(i001: 13, i002: 16, i003: 29, i004: 47, i005: 60 pushes), in about 0.6 s
for the whole set — far inside the 60 s wall budget. It also scores
1,000,000 on 13 freshly drawn sets from the kit's own generator.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `<input>/<id>/level.txt` for each instance id and writes
`<output>/<id>/solution.txt` (the player's moves in `u`, `d`, `l`, `r`;
uppercase letters mark pushes). With no environment variables it reads
`/input` and writes `/output`, as the grader runs it (`node /bot/main.ts`).

## Files

- `main.ts` — the whole solver (entrypoint the grader runs).
- `LICENSE` — MIT.
