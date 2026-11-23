// Sokoban solver for make.fun "Build the best Sokoban solver, 21 November 2026".
//
// Approach (original work, written for this bounty):
//   A level is a hallway with independent rooms off it: a box pushed out of a
//   room's door into the hallway can never come back, so every box stays in its
//   room and the level's push-optimal count is the sum of the rooms' optima.
//   This solver therefore
//     1. splits the level into rooms (connected floor components once the
//        hallway row is removed),
//     2. solves each room push-optimally with A* over pushes (cost = pushes,
//        admissible heuristic = minimum assignment of boxes to goals under
//        shortest-path distances, plus dead-square and 2x2-freeze pruning),
//     3. stitches the rooms together with plain walks through the hallway.
//   If the split fails for any reason it falls back to a whole-level push A*
//   (same machinery, sum-of-minimum-distances heuristic).
//
// The run is deterministic: fixed direction order, fixed expansion budgets,
// no clock, no randomness, no environment reads beyond the input/output dirs.
// A run past the wall budget would earn nothing, so work is bounded by
// expansion counts, never by time.
//
// Usage: node main.ts  (reads $MAKEFUN_INPUT_DIR or /input, writes
// $MAKEFUN_OUTPUT_DIR or /output, one solution.txt per instance id).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Push/search budgets: bounded by work, not by the clock, so two runs agree.
const ROOM_EXPANSIONS = 400_000;
const GLOBAL_EXPANSIONS = 300_000;

const DIRS: ReadonlyArray<readonly [number, number, string]> = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch !== '#') wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** All cells reachable from `from` on non-wall cells not in `blocked`. Sorted. */
function region(w: number, wall: Uint8Array, blocked: Uint8Array, from: number): number[] {
  const seen = new Uint8Array(wall.length);
  const out: number[] = [from];
  seen[from] = 1;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    for (const [dx, dy] of DIRS) {
      const q = c + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (!wall[q] && !blocked[q] && !seen[q]) {
        seen[q] = 1;
        out.push(q);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Shortest walk from `from` to `to` avoiding walls and `blocked`; move letters or null. */
function walkPath(
  w: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-2);
  const prevDir = new Int8Array(wall.length);
  prev[from] = -1;
  const queue: number[] = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    for (let d = 0; d < 4; d++) {
      const [dx, dy, letter] = DIRS[d]!;
      const q = c + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (!wall[q] && !blocked[q] && prev[q] === -2) {
        prev[q] = c;
        prevDir[q] = d;
        if (q === to) {
          let s = '';
          let cur = q;
          while (cur !== from) {
            s = DIRS[prevDir[cur]!]![2] + s;
            cur = prev[cur]!;
          }
          return s;
        }
        queue.push(q);
      }
    }
  }
  return null;
}

/** BFS distances from `src` over non-wall cells (ignoring boxes). -1 = unreachable. */
function distancesFrom(w: number, wall: Uint8Array, src: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  dist[src] = 0;
  const queue: number[] = [src];
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = c + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[c]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** Cells a box can never be pushed from to any goal (reverse-push reachability). */
function deadSquares(w: number, wall: Uint8Array, boxFloor: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  // Reverse of a push: box at y came from y-d with the player standing at y-2d.
  for (let qi = 0; qi < queue.length; qi++) {
    const y = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const prev = y - d;
      const stance = y - 2 * d;
      if (prev < 0 || prev >= wall.length || stance < 0 || stance >= wall.length) continue;
      if (boxFloor[prev] && !wall[stance] && !live[prev]) {
        live[prev] = 1;
        queue.push(prev);
      }
    }
  }
  const dead = new Uint8Array(wall.length);
  for (let i = 0; i < wall.length; i++) if (boxFloor[i] && !live[i]) dead[i] = 1;
  return dead;
}

/** True when a box off its goal sits in a frozen 2x2 block of walls/boxes. */
function frozen2x2(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goalSet: Uint8Array,
  b: number,
): boolean {
  if (goalSet[b]) return false;
  const x = b % w;
  const y = Math.floor(b / w);
  for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
    const cells = [
      (y + oy) * w + (x + ox),
      (y + oy) * w + (x + ox + 1),
      (y + oy + 1) * w + (x + ox),
      (y + oy + 1) * w + (x + ox + 1),
    ];
    if (cells.some((c) => c < 0 || c >= wall.length)) continue;
    if (cells.every((c) => wall[c] || occupied[c])) return true;
  }
  return false;
}

interface PushStep {
  box: number;
  dir: number; // index into DIRS
}

interface PushSolution {
  pushes: PushStep[];
  expansions: number;
}

/**
 * Push-optimal A* over one box set.
 * `boxFloor`: cells boxes may occupy. `walkFloor`: cells the player may occupy
 * (boxFloor plus the entry square, if any). `exitCell`: when given, a solved
 * state must also let the player reach it (so the player can leave the room);
 * pass -1 to skip that requirement. `assignment`: true uses the min-assignment
 * heuristic (small box counts); false uses the cheaper sum-of-minima.
 */
function solvePushes(
  w: number,
  wall: Uint8Array,
  boxFloor: Uint8Array,
  walkFloor: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  exitCell: number,
  assignment: boolean,
  maxExpansions: number,
): PushSolution | null {
  const goalSet = new Uint8Array(wall.length);
  for (const g of goals) goalSet[g] = 1;
  const dead = deadSquares(w, wall, boxFloor, goals);
  for (const b of boxes0) if (dead[b] && !goalSet[b]) return null;

  const n = boxes0.length;
  // Distance from every goal to every cell (walls only), for the heuristic.
  const goalDist = goals.map((g) => distancesFrom(w, wall, g));
  // Permutations of goal indices for the assignment heuristic.
  const perms: number[][] = [];
  if (assignment) {
    const idx = goals.map((_, i) => i);
    const gen = (a: number[], k: number): void => {
      if (k === 1) {
        perms.push(a.slice());
        return;
      }
      for (let i = 0; i < k; i++) {
        gen(a, k - 1);
        const j = k % 2 === 0 ? i : 0;
        [a[j], a[k - 1]] = [a[k - 1]!, a[j]!];
      }
    };
    gen(idx, idx.length);
  }
  const heuristic = (boxes: number[]): number => {
    if (assignment) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = goalDist[p[i]!]![boxes[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < goals.length; gi++) {
        const d = goalDist[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  // Effective wall for walking: walls plus cells outside walkFloor.
  const walkWall = new Uint8Array(wall.length);
  for (let i = 0; i < wall.length; i++) walkWall[i] = wall[i] || !walkFloor[i] ? 1 : 0;

  const keyOf = (boxes: number[], canonPlayer: number): string =>
    boxes.join(',') + '|' + canonPlayer;

  // Node storage: parent, push that created it, player cell after the push.
  const parent: number[] = [-1];
  const pushBox: number[] = [-1];
  const pushDir: number[] = [-1];
  const nodePlayer: number[] = [player0];
  const nodeBoxes: number[][] = [boxes0.slice()];
  const nodeG: number[] = [0];
  const best = new Map<string, number>();

  const canonPlayerOf = (boxes: number[], player: number): number => {
    const occ = new Uint8Array(wall.length);
    for (const b of boxes) occ[b] = 1;
    return region(w, walkWall, occ, player)[0]!;
  };
  best.set(keyOf(boxes0, canonPlayerOf(boxes0, player0)), 0);

  // Binary heap of [f, -g, nodeId]; deeper first on ties.
  const heap: [number, number, number][] = [];
  const heapLess = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  heapPush([heuristic(boxes0), 0, 0]);
  let expansions = 0;
  while (heap.length > 0) {
    const [, negG, id] = heapPop();
    const g = -negG;
    const boxes = nodeBoxes[id]!;
    if (nodeG[id] !== g) continue; // stale heap entry
    if (best.get(keyOf(boxes, canonPlayerOf(boxes, nodePlayer[id]!))) !== id) continue;
    // Goal: every box on a goal, and (when asked) the player can reach the exit.
    if (boxes.every((b) => goalSet[b])) {
      if (exitCell < 0) {
        return { pushes: tracePushes(id), expansions };
      }
      const occ = new Uint8Array(wall.length);
      for (const b of boxes) occ[b] = 1;
      if (region(w, walkWall, occ, nodePlayer[id]!).includes(exitCell)) {
        return { pushes: tracePushes(id), expansions };
      }
      // Solved but the player cannot leave: keep searching for another optimum.
    }
    if (expansions >= maxExpansions) return null;
    expansions++;
    const occ = new Uint8Array(wall.length);
    for (const b of boxes) occ[b] = 1;
    const reach = region(w, walkWall, occ, nodePlayer[id]!);
    const reachSet = new Uint8Array(wall.length);
    for (const c of reach) reachSet[c] = 1;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d]!;
        const dd = dy * w + dx;
        const target = b + dd;
        const stance = b - dd;
        if (target < 0 || target >= wall.length || stance < 0 || stance >= wall.length) continue;
        if (!boxFloor[target] || occ[target]) continue;
        if (!reachSet[stance]) continue;
        if (dead[target] && !goalSet[target]) continue;
        const nb = boxes.slice();
        nb[bi] = target;
        nb.sort((a, b2) => a - b2);
        const nocc = new Uint8Array(wall.length);
        for (const x of nb) nocc[x] = 1;
        if (nb.some((x) => frozen2x2(w, wall, nocc, goalSet, x))) continue;
        const h = heuristic(nb);
        if (h === Infinity) continue;
        const canon = canonPlayerOf(nb, b);
        const k = keyOf(nb, canon);
        const seen = best.get(k);
        if (seen !== undefined && nodeG[seen]! <= g + 1) continue;
        const nid = nodeBoxes.length;
        parent.push(id);
        pushBox.push(b);
        pushDir.push(d);
        nodePlayer.push(b);
        nodeBoxes.push(nb);
        nodeG.push(g + 1);
        best.set(k, nid);
        heapPush([g + 1 + h, -(g + 1), nid]);
      }
    }
  }
  return null;

  function tracePushes(id: number): PushStep[] {
    const steps: PushStep[] = [];
    for (let t = id; t > 0; t = parent[t]!) {
      steps.push({ box: pushBox[t]!, dir: pushDir[t]! });
    }
    steps.reverse();
    return steps;
  }
}

/**
 * Replay a push sequence from the start state, filling in the walks, and
 * return the full move string (lowercase walks, uppercase pushes).
 */
function renderMoves(
  w: number,
  wall: Uint8Array,
  boxes0: number[],
  player0: number,
  pushes: PushStep[],
): string | null {
  const boxes = boxes0.slice();
  let player = player0;
  let moves = '';
  for (const { box, dir } of pushes) {
    const [dx, dy, letter] = DIRS[dir]!;
    const dd = dy * w + dx;
    const stance = box - dd;
    const occ = new Uint8Array(wall.length);
    for (const b of boxes) occ[b] = 1;
    const walk = walkPath(w, wall, occ, player, stance);
    if (walk === null) return null;
    moves += walk + letter.toUpperCase();
    const at = boxes.indexOf(box);
    if (at < 0) return null;
    boxes[at] = box + dd;
    boxes.sort((a, b) => a - b);
    player = box;
  }
  return moves;
}

/** Split a level into rooms: floor components once the hallway row is removed. */
function splitRooms(level: Level): { cells: number[]; door: number; entry: number }[] | null {
  const { w, h, wall, player } = level;
  const hallRow = Math.floor(player / w);
  // The hallway row must be a corridor the player stands in.
  const blocked = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) blocked[hallRow * w + x] = 1;
  const seen = new Uint8Array(wall.length);
  const rooms: { cells: number[]; door: number; entry: number }[] = [];
  for (let i = 0; i < wall.length; i++) {
    if (wall[i] || blocked[i] || seen[i]) continue;
    // Flood one component.
    const cells: number[] = [i];
    seen[i] = 1;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]!;
      for (const [dx, dy] of DIRS) {
        const q = c + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !blocked[q] && !seen[q]) {
          seen[q] = 1;
          cells.push(q);
        }
      }
    }
    cells.sort((a, b) => a - b);
    // The door: a component cell next to a hallway-row floor cell.
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      for (const [dx, dy] of DIRS) {
        const q = c + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (Math.floor(q / w) === hallRow && !wall[q]) {
          door = c;
          entry = q;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) return null; // a component with no door: not the hallway/rooms shape
    rooms.push({ cells, door, entry });
  }
  return rooms;
}

function solveLevel(level: Level): string {
  const { w, wall, goals, boxes, player } = level;
  const rooms = splitRooms(level);
  if (rooms !== null) {
    // Every room must hold boxes and goals, and every box must be in a room.
    const roomOf = new Map<number, number>();
    rooms.forEach((r, i) => r.cells.forEach((c) => roomOf.set(c, i)));
    const ok =
      rooms.every(
        (r) =>
          r.cells.some((c) => boxes.includes(c)) && r.cells.some((c) => goals.includes(c)),
      ) && boxes.every((b) => roomOf.has(b));
    if (ok) {
      // Solve rooms one at a time, in door-column order (deterministic).
      const order = rooms.map((_, i) => i).sort((a, b) => rooms[a]!.door - rooms[b]!.door);
      const curBoxes = boxes.slice();
      let curPlayer = player;
      let moves = '';
      for (const ri of order) {
        const room = rooms[ri]!;
        const boxFloor = new Uint8Array(wall.length);
        for (const c of room.cells) boxFloor[c] = 1;
        const walkFloor = new Uint8Array(wall.length);
        for (const c of room.cells) walkFloor[c] = 1;
        walkFloor[room.entry] = 1;
        const roomBoxes = curBoxes.filter((b) => roomOf.get(b) === ri).sort((a, b) => a - b);
        const roomGoals = goals.filter((g) => room.cells.includes(g)).sort((a, b) => a - b);
        const sol = solvePushes(
          w,
          wall,
          boxFloor,
          walkFloor,
          roomGoals,
          roomBoxes,
          room.entry,
          room.door,
          true,
          ROOM_EXPANSIONS,
        );
        if (sol === null) return fallbackSolve(level);
        // Walk from where the player stands to the room's entry square.
        const occ = new Uint8Array(wall.length);
        for (const b of curBoxes) occ[b] = 1;
        const toEntry = walkPath(w, wall, occ, curPlayer, room.entry);
        if (toEntry === null) return fallbackSolve(level);
        moves += toEntry;
        const roomMoves = renderMoves(w, wall, roomBoxes, room.entry, sol.pushes);
        if (roomMoves === null) return fallbackSolve(level);
        moves += roomMoves;
        // Replay the room solution to update the world state.
        const replay = replayMoves(w, wall, curBoxes, room.entry, roomMoves);
        if (replay === null) return fallbackSolve(level);
        curBoxes.splice(0, curBoxes.length, ...replay.boxes);
        curPlayer = replay.player;
        // Walk out of the room to its entry square (exit is guaranteed reachable).
        const occ2 = new Uint8Array(wall.length);
        for (const b of curBoxes) occ2[b] = 1;
        const out = walkPath(w, wall, occ2, curPlayer, room.entry);
        if (out === null) return fallbackSolve(level);
        moves += out;
        curPlayer = room.entry;
      }
      return moves;
    }
  }
  return fallbackSolve(level);
}

/** Whole-level push A* (fallback when the room split does not apply). */
function fallbackSolve(level: Level): string {
  const { w, wall, goals, boxes, player } = level;
  const boxFloor = new Uint8Array(wall.length);
  const walkFloor = new Uint8Array(wall.length);
  for (let i = 0; i < wall.length; i++) {
    if (!wall[i]) {
      boxFloor[i] = 1;
      walkFloor[i] = 1;
    }
  }
  const sol = solvePushes(
    w,
    wall,
    boxFloor,
    walkFloor,
    goals,
    boxes,
    player,
    -1,
    false,
    GLOBAL_EXPANSIONS,
  );
  if (sol === null) return '';
  return renderMoves(w, wall, boxes, player, sol.pushes) ?? '';
}

/** Replay a move string; returns the resulting boxes/player, or null on illegality. */
function replayMoves(
  w: number,
  wall: Uint8Array,
  boxes0: number[],
  player0: number,
  moves: string,
): { boxes: number[]; player: number } | null {
  const boxes = boxes0.slice();
  let player = player0;
  for (const ch of moves) {
    const d = DIRS.find(([, , l]) => l === ch.toLowerCase());
    if (!d) return null;
    const [dx, dy] = d;
    const dd = dy * w + dx;
    const next = player + dd;
    if (next < 0 || next >= wall.length || wall[next]) return null;
    const at = boxes.indexOf(next);
    if (at >= 0) {
      const beyond = next + dd;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] || boxes.includes(beyond)) return null;
      boxes[at] = beyond;
      boxes.sort((a, b) => a - b);
    }
    player = next;
  }
  return { boxes, player };
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
  const moves = solveLevel(parseLevel(text));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
