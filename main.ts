// Push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Why this shape: the checker scores pushes, not moves — a solved level earns
// 1,000 points only at the push-optimal count P*, and under half for even one
// push more. The levels are built as a hallway with independent rooms off it
// (a box pushed out of its room can never come back), and P* is the sum of the
// rooms' push optima. So this solver splits each level into its rooms, solves
// every room push-optimally with an A* search over pushes, and stitches the
// rooms together with plain walks, which cost no pushes.
//
// Room search, per room (at most 4 boxes on a 6x6 slot plus its door):
//   - states are (sorted box squares, the player's reachable region named by
//     its lowest square), expanded by single pushes;
//   - pull distances: for every goal, the fewest pushes that bring one box
//     from each square to that goal, other boxes ignored (reverse BFS);
//   - the heuristic is the cheapest assignment of boxes to goals under those
//     distances — admissible, so the solution A* settles on is optimal;
//   - pruning: a box on a square that reaches no goal is dead, and a frozen
//     2x2 block of walls and boxes with a box off its goal is dead.
// Everything is budgeted by expansions, never by the clock, and every tie is
// broken by a fixed order, so two runs write byte-identical answers. If the
// optimal search ever exhausts its budget, a greedy best-first search still
// returns some solution rather than none; if that fails too, the instance is
// answered empty (a valid answer worth 0) — the run never crashes and always
// writes every instance's file. Before anything is written, each answer is
// replayed with the checker's own rules; an answer that does not solve its
// level cleanly is replaced by the empty one.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps: [dx, dy, walk letter, push letter].
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
const INF = 1e9;
// Deterministic work budgets, in search expansions, set from measurement:
// over the practice set and 40 freshly drawn sets (205 rooms), the hardest
// single room needed 1,270 A* expansions and the slowest whole set ran in
// about half a second on one CPU. The per-room cap matches the state budget
// the generator itself allows a room's plain breadth-first search, which
// this A* undercuts by orders of magnitude; the set budget bounds the whole
// run's worst case far inside the 60 second wall even on a slower machine.
const ROOM_ASTAR_CAP = 250000;
const ROOM_GREEDY_CAP = 150000;
const SET_BUDGET = 900000;

/** A parsed level: walls, goals, boxes, player, all as flat square indices. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Squares from which one box, pushed alone, can reach some goal (reverse pulls from the goals). */
function liveSquares(w, wall, goals) {
  const live = new Uint8Array(wall.length);
  const queue = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      // A box at y is pushed onto x when the player stands at y - d.
      if (y >= 0 && y < wall.length && !wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway —
 * a box there reaches no goal) out of the floor and flood-fill what is left;
 * each part holding boxes is a room, with the hallway square outside its door
 * as its entry. Returns null when the level is not a clean set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  if (player < 0) return null;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q >= 0 && q < wall.length && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], entry: -1 });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  for (const r of withBoxes) {
    if (r.boxes.length !== r.goals.length) return null;
    // The entry: a cut square (hallway) next to one of the room's squares.
    for (const s of r.squares) {
      for (const [dx, dy] of DIRS) {
        const q = s + dy * w + dx;
        if (q >= 0 && q < wall.length && cut[q]) r.entry = q;
      }
    }
    if (r.entry < 0) return null;
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
  }
  return withBoxes;
}

/** All permutations of [0..n), in a fixed order. Only used for n <= 7. */
function permutations(n) {
  if (n <= 1) return [Array.from({ length: n }, (_, i) => i)];
  const out = [];
  for (const rest of permutations(n - 1)) {
    for (let i = 0; i < n; i++) {
      const p = rest.slice();
      p.splice(i, 0, n - 1);
      out.push(p);
    }
  }
  return out;
}

/**
 * A push search on one board. `cells` are the board's floor squares (flat
 * level indices); boxes may sit only on `boxCells` (a subset — a room's own
 * squares, never its entry); the player walks on all `cells`. Returns the
 * push list [{from, dir}] of a push-optimal solution (mode 'astar') or of
 * any solution (mode 'greedy'), or null when the expansion cap runs out.
 * `budget` is a shared {left} counter decremented per expansion.
 */
function searchBoard(level, cells, boxCells, goals, startBoxes, startPlayer, cap, budget, mode) {
  const { w, wall } = level;
  const n = cells.length;
  const local = new Map();
  cells.forEach((c, i) => local.set(c, i));
  // Neighbours per local square per direction: a local index, or -1 (wall / off the board).
  const nbr = new Int32Array(n * 4).fill(-1);
  cells.forEach((c, i) => {
    for (let d = 0; d < 4; d++) {
      const q = c + DIRS[d][1] * w + DIRS[d][0];
      if (local.has(q)) nbr[i * 4 + d] = local.get(q);
    }
  });
  const boxAllowed = new Uint8Array(n);
  for (const c of boxCells) boxAllowed[local.get(c)] = 1;
  const goalSet = new Set(goals.map((g) => local.get(g)));
  // Pull distances per goal: dist[gi][v] = fewest pushes moving one box from
  // local square v to goal gi, other boxes ignored (reverse BFS over pushes:
  // a box at y is pushed in direction d onto x when the player stands at y-d).
  const dist = goals.map((g) => {
    const dg = new Int32Array(n).fill(INF);
    const start = local.get(g);
    dg[start] = 0;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (let d = 0; d < 4; d++) {
        const back = d ^ 1; // the direction opposite d (DIRS pairs up/down, left/right)
        const y = nbr[x * 4 + back];
        if (y < 0 || dg[y] !== INF) continue;
        if (nbr[y * 4 + back] < 0) continue; // no square to stand on for that push
        dg[y] = dg[x] + 1;
        queue.push(y);
      }
    }
    return dg;
  });
  const dead = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    if (!goalSet.has(v) && dist.every((dg) => dg[v] >= INF)) dead[v] = 1;
  }
  const start = startBoxes.map((b) => local.get(b)).sort((a, b) => a - b);
  if (start.some((b) => dead[b])) return null;
  // The heuristic: the cheapest assignment of boxes to goals under the pull
  // distances (exact permutations for few boxes; the sum of each box's own
  // nearest-goal distance otherwise — both admissible).
  const perms = start.length <= 7 ? permutations(start.length) : null;
  const hCache = new Map();
  const heuristic = (bs) => {
    const key = bs.join(',');
    let hv = hCache.get(key);
    if (hv !== undefined) return hv;
    hv = INF;
    if (perms !== null) {
      for (const p of perms) {
        let sum = 0;
        for (let i = 0; i < bs.length; i++) {
          const d = dist[p[i]][bs[i]];
          if (d >= INF) {
            sum = INF;
            break;
          }
          sum += d;
        }
        if (sum < hv) hv = sum;
      }
    } else {
      let sum = 0;
      for (const b of bs) {
        let m = INF;
        for (const dg of dist) if (dg[b] < m) m = dg[b];
        if (m >= INF) {
          sum = INF;
          break;
        }
        sum += m;
      }
      hv = sum;
    }
    hCache.set(key, hv);
    return hv;
  };
  // The frozen-2x2 test: the board's 2x2 blocks whose four squares are all
  // board squares or genuine walls (a block touching open floor outside the
  // board proves nothing and is skipped). Squares are local indices, -2 a wall.
  const blocksAt = Array.from({ length: n }, () => []);
  cells.forEach((c, i) => {
    const x = c % w;
    const y = Math.floor(c / w);
    if (x + 1 >= w || y + 1 >= level.h) return;
    const flat = [c, c + 1, c + w, c + w + 1];
    const sq = [];
    for (const f of flat) {
      if (local.has(f)) sq.push(local.get(f));
      else if (wall[f]) sq.push(-2);
      else return; // open floor outside the board: not a frozen-block witness
    }
    for (const v of sq) if (v >= 0) blocksAt[v].push(sq);
  });
  const frozen = (occ, t) => {
    for (const b of blocksAt[t]) {
      let solid = true;
      let offGoal = false;
      for (const v of b) {
        if (v >= 0 && !occ[v]) {
          solid = false;
          break;
        }
        if (v >= 0 && occ[v] && !goalSet.has(v)) offGoal = true;
      }
      if (solid && offGoal) return true;
    }
    return false;
  };

  // Player regions: a flood fill over the board with boxes as obstacles,
  // named by its lowest square.
  const regionStamp = new Int32Array(n);
  const regionStack = new Int32Array(n);
  let stamp = 0;
  const regionLow = (occ, from) => {
    stamp++;
    let low = from;
    let top = 0;
    regionStack[top++] = from;
    regionStamp[from] = stamp;
    while (top > 0) {
      const p = regionStack[--top];
      if (p < low) low = p;
      for (let d = 0; d < 4; d++) {
        const q = nbr[p * 4 + d];
        if (q >= 0 && !occ[q] && regionStamp[q] !== stamp) {
          regionStamp[q] = stamp;
          regionStack[top++] = q;
        }
      }
    }
    return low;
  };
  const keyOf = (bs, low) => low + '|' + bs.join(',');
  const solved = (bs) => bs.every((b) => goalSet.has(b));

  // The states, in parallel arrays; the open list is a binary heap ordered
  // by (priority, then deeper g, then insertion order) — all fixed, so the
  // search is deterministic. A state is settled when it is popped; the best
  // map re-opens a state reached again with fewer pushes.
  const sBoxes = [start];
  const sPlayer = [0];
  const sG = [0];
  const sKey = [''];
  const sParent = [-1];
  const sFrom = [-1]; // the pushed box's square before the push (flat level index)
  const sDir = [-1];
  const best = new Map();
  {
    const occ = new Uint8Array(n);
    for (const b of start) occ[b] = 1;
    const low = regionLow(occ, local.get(startPlayer));
    sPlayer[0] = low;
    sKey[0] = keyOf(start, low);
    best.set(sKey[0], 0);
  }
  const heap = [];
  let counter = 0;
  const hLess = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const hPush = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!hLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const hPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && hLess(heap[c + 1], heap[c])) c++;
        if (!hLess(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  const h0 = heuristic(start);
  if (h0 >= INF) return null;
  hPush([h0, 0, counter++, 0]);
  let found = -1;
  let expansions = 0;
  const occ = new Uint8Array(n);
  const region = new Uint8Array(n);
  while (heap.length > 0) {
    const [, , , s] = hPop();
    if (sG[s] > best.get(sKey[s])) continue; // a better copy of this state exists
    if (solved(sBoxes[s])) {
      found = s;
      break;
    }
    if (expansions >= cap || budget.left <= 0) return null;
    expansions++;
    budget.left--;
    const bs = sBoxes[s];
    occ.fill(0);
    for (const b of bs) occ[b] = 1;
    // The player's reachable region of this state, as a boolean array.
    stamp++;
    region.fill(0);
    let top = 0;
    regionStack[top++] = sPlayer[s];
    regionStamp[sPlayer[s]] = stamp;
    while (top > 0) {
      const p = regionStack[--top];
      region[p] = 1;
      for (let d = 0; d < 4; d++) {
        const q = nbr[p * 4 + d];
        if (q >= 0 && !occ[q] && regionStamp[q] !== stamp) {
          regionStamp[q] = stamp;
          regionStack[top++] = q;
        }
      }
    }
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let d = 0; d < 4; d++) {
        const stand = nbr[b * 4 + (d ^ 1)];
        const target = nbr[b * 4 + d];
        if (stand < 0 || target < 0 || !region[stand] || occ[target] || !boxAllowed[target] || dead[target]) continue;
        occ[b] = 0;
        occ[target] = 1;
        const isFrozen = frozen(occ, target);
        const low = isFrozen ? -1 : regionLow(occ, b);
        occ[target] = 0;
        occ[b] = 1;
        if (isFrozen) continue;
        const nb = bs.slice();
        nb[bi] = target;
        nb.sort((a, b) => a - b);
        const hv = heuristic(nb);
        if (hv >= INF) continue;
        const g = sG[s] + 1;
        const key = keyOf(nb, low);
        const seen = best.get(key);
        if (seen !== undefined && seen <= g) continue;
        best.set(key, g);
        const t = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(low);
        sG.push(g);
        sKey.push(key);
        sParent.push(s);
        sFrom.push(cells[b]);
        sDir.push(d);
        hPush([mode === 'astar' ? g + hv : hv, g, counter++, t]);
      }
    }
  }
  if (found < 0) return null;
  const pushes = [];
  for (let s = found; s > 0; s = sParent[s]) pushes.push({ from: sFrom[s], dir: sDir[s] });
  pushes.reverse();
  return pushes;
}

/** The shortest walk from `from` to `to` on the level, boxes as obstacles; '' when already there, null when unreachable. */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Replay `moves` on the level with the checker's rules: {solved, pushes}, or null on an illegal step. */
function replay(level, moves) {
  const { w, wall } = level;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  const goal = new Uint8Array(wall.length);
  for (const g of level.goals) goal[g] = 1;
  let player = level.player;
  let pushes = 0;
  for (const ch of moves) {
    const dir = DIRS.find(([, , letter]) => letter === ch.toLowerCase());
    if (!dir) return null;
    const d = dir[1] * w + dir[0];
    const next = player + d;
    if (next < 0 || next >= wall.length || wall[next]) return null;
    if (box[next]) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] || box[beyond]) return null;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return { solved: false, pushes };
  return { solved: true, pushes };
}

/** Solve one level to a move string ('' when no solution was found). */
function solveLevel(level, budget) {
  const rooms = roomsOf(level);
  const plan = [];
  if (rooms !== null && rooms.length > 0) {
    // Solve every room on its own board: its squares plus the entry square.
    for (const room of rooms) {
      const cells = room.squares.concat([room.entry]);
      const pushes =
        searchBoard(level, cells, room.squares, room.goals, room.boxes, room.entry, ROOM_ASTAR_CAP, budget, 'astar') ??
        searchBoard(level, cells, room.squares, room.goals, room.boxes, room.entry, ROOM_GREEDY_CAP, budget, 'greedy');
      if (pushes === null) return '';
      plan.push(pushes);
    }
  } else {
    // No clean room split (never happens for this generator): search the
    // whole board at once, boxes allowed anywhere on the floor.
    const cells = [];
    for (let i = 0; i < level.wall.length; i++) if (!level.wall[i]) cells.push(i);
    const pushes =
      searchBoard(level, cells, cells, level.goals, level.boxes, level.player, ROOM_ASTAR_CAP, budget, 'astar') ??
      searchBoard(level, cells, cells, level.goals, level.boxes, level.player, ROOM_GREEDY_CAP, budget, 'greedy');
    if (pushes === null) return '';
    plan.push(pushes);
  }
  // Stitch the plan on the real board: walk to each push's standing square,
  // then push. Walks cost no pushes, so the rooms' optima add up.
  const occupied = new Uint8Array(level.wall.length);
  for (const b of level.boxes) occupied[b] = 1;
  let player = level.player;
  let moves = '';
  for (const pushes of plan) {
    for (const push of pushes) {
      const d = DIRS[push.dir][1] * level.w + DIRS[push.dir][0];
      const stand = push.from - d;
      const walk = walkTo(level, occupied, player, stand);
      if (walk === null) return '';
      moves += walk + DIRS[push.dir][3];
      occupied[push.from] = 0;
      occupied[push.from + d] = 1;
      player = push.from;
    }
  }
  // Trust nothing: replay the answer with the checker's rules before use.
  const check = replay(level, moves);
  if (check === null || !check.solved) return '';
  return moves;
}

// One work budget for the whole set, spent by every search in turn.
const budget = { left: SET_BUDGET };
for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level, budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
