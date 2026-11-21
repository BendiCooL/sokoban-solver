# Sokoban Solver — push-optimal, room by room

[![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/BendiCooL/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/BendiCooL/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

An entry for make.fun's [Build the best Sokoban solver](https://make.fun/bounty/sokoban-solver-01-run-20261121) (sokoban-solver-01-run-20261121).

`main.ts` (Node 22, standard library only) reads every level under `/input`
and writes its moves to `/output/<id>/solution.txt`. The checker scores
pushes, not moves: a level solved in the push-optimal count P* earns the
full 1,000 points, and even one push more earns under half. The generated
levels are a hallway with independent rooms off it — a box pushed out of
its room can never be pushed back — and P* is the sum of the rooms' optima.

How it works:

- **Split.** Dead squares of the player's row (the hallway: a box there
  reaches no goal) are cut out of the floor; each remaining part that holds
  boxes is one room, entered from the hallway square outside its door.
- **Solve each room push-optimally.** An A* search over pushes: states are
  the sorted box squares plus the player's reachable region, named by its
  lowest square. The heuristic is the cheapest assignment of boxes to goals
  under precomputed pull distances (reverse BFS per goal), which is
  admissible, so the solution found is push-optimal. Dead squares and
  frozen 2x2 blocks prune the search.
- **Stitch.** The rooms' push sequences are replayed on the real board,
  walking the player to each push's standing square; walks cost no pushes,
  so the optima add up to the level's P*.
- **Stay safe.** All budgets are counted in expansions, never by the clock,
  and every tie breaks by a fixed order, so two runs write byte-identical
  answers. A greedy best-first fallback still returns a solution if the
  optimal search ever exhausts its budget, every answer is replayed with
  the checker's own rules before it is written, and the program never
  crashes: an instance it cannot solve is answered empty, which is a valid
  answer worth 0.

On the kit's practice set it solves all five instances in exactly P*
pushes (13, 16, 29, 47 and 60) — a score of 1,000,000, against the house
baseline plain-astar 1.0.0's 200,000 (it solves only the first instance).

## Layout

- `main.ts` — the whole solver: parsing, room splitting, the push search,
  stitching and the self-check replay.
- `.makefun/owner.json` — the make.fun claim file naming the owner's wallet.
- `LICENSE` — MIT.
