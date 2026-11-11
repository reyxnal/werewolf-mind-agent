// Quiet Village Strategist: a deterministic, model-free Werewolf agent.
//
// This entry plays 8-player Werewolf (2 werewolves, 1 seer, 1 doctor, 4 villagers)
// purely on code: it makes no model call at all, which this competition expressly
// allows (model_calls: optional). Every decision is a pure function of the game's
// own view as the env serves it, plus the trial seed, so the live pass and the
// replay pass produce byte-identical requests: no clock, no unseeded randomness,
// one env request at a time, in order.
//
// Strategy, in short:
//  - A belief model over seats is rebuilt from the public log on every decision:
//    revealed roles, day votes, speeches, and seer claims (with the reports each
//    claimant published) are folded into a suspicion score per living seat.
//  - Claims are audited: a claimant whose named wolf is later revealed a wolf is
//    proven the seer and trusted completely; a claimant whose report is refuted
//    by a revealed role is proven a liar and treated as a known werewolf.
//  - As the seer, inspections go to the most suspicious uninspected seat; a found
//    werewolf is reported to the village in the next debate, with the full check
//    history, and a counter-claimant is exposed at once (there is only one seer).
//  - As the doctor, protection follows the credible seer first, then the village
//    player the wolves most want dead; the doctor never claims.
//  - As a werewolf, the second night vote always confirms the partner's pick so
//    the kill lands; the first vote hunts the seer and the village's leaders.
//    By day the wolf votes with the village against villagers, defends the partner
//    only while it is cheap, buses a partner the seer has proven, and — once the
//    real seer is dead and parity is one mislynch away — claims the seer's seat
//    to name a trusted villager as a wolf.
//  - Speech is short, factual and in character: deductions cite votes and revealed
//    roles, never anything outside the speaker's own view of the game.
//
// Run by the grader as `node /bot/main.ts`; Node's standard library only.

type Seat = number;
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  target?: Seat | null;
  round?: number;
  text?: string;
  died?: Seat | null;
  role?: string | null;
  tally?: { seat: Seat; votes: number }[];
  [k: string]: unknown;
}

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: string;
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** A small stable string hash (FNV-1a), so seeded choices replay identically. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded pick from a non-empty list: a function of the trial seed alone. */
function seededPick<T>(seed: string, salt: string, list: readonly T[]): T {
  return list[hashStr(`${seed}|${salt}`) % list.length]!;
}

/** A statement folded to one line the env's way, and cut to the limit. */
function fold(text: string, max: number): string {
  const one = text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  return [...one].length > max ? [...one].slice(0, max).join('').trim() : one;
}

const VILLAGE_ROLES = new Set(['seer', 'doctor', 'villager']);
const isVillageRole = (role: string | null | undefined): boolean =>
  role !== null && role !== undefined && VILLAGE_ROLES.has(role);

// ---------------------------------------------------------------------------
// Reading the table: claims, reports and the suspicion model
// ---------------------------------------------------------------------------

interface Report {
  target: Seat;
  wolf: boolean;
  day: number;
}

interface Claim {
  seat: Seat;
  reports: Report[];
}

/** Seats a speech names: "seat 4", "player 4", "#4". */
function namedSeats(text: string): Seat[] {
  const out: Seat[] = [];
  const re = /(?:seat|player)\s*#?\s*(\d)|#(\d)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1] ?? m[2]);
    if (n >= 1 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out;
}

const SEER_CLAIM =
  /\b(i am|i'm|im|this is|me,?|speaking as|claiming|i claim)\b[^.]{0,24}\bseer\b|\bseer here\b|\bi checked\b|\bi inspected\b|\bmy (night|check|inspection)\b/i;
const WOLF_WORD = '(?:werewolf|wolf)';
const CLEAN_WORD = '(?:clean|innocent|not a (?:werewolf|wolf)|village(?:r)?|good)';

/** The check reports inside one speech: (target, is-wolf) pairs. */
function reportsIn(text: string): Report[] {
  const out: Report[] = [];
  const push = (target: Seat, wolf: boolean) => {
    if (target >= 1 && target <= 8 && !out.some((r) => r.target === target)) out.push({ target, wolf, day: 0 });
  };
  let m: RegExpExecArray | null;
  const wolfRes = [
    new RegExp(`(?:seat|player)\\s*#?\\s*(\\d)[^.]{0,40}?\\b(?:is|was|came back|flipped|checked)\\b[^.]{0,24}?\\b${WOLF_WORD}\\b`, 'gi'),
    new RegExp(`\\b(?:checked|inspected|saw)\\b[^.]{0,24}?(?:seat|player)\\s*#?\\s*(\\d)[^.]{0,24}?\\b${WOLF_WORD}\\b`, 'gi'),
    new RegExp(`\\b(\\d)\\s*[:=-]\\s*${WOLF_WORD}\\b`, 'gi'),
  ];
  for (const re of wolfRes) {
    while ((m = re.exec(text)) !== null) push(Number(m[1]), true);
  }
  const cleanRes = [
    new RegExp(`(?:seat|player)\\s*#?\\s*(\\d)[^.]{0,40}?\\b(?:is|was|came back|checked)\\b[^.]{0,24}?\\b${CLEAN_WORD}\\b`, 'gi'),
    new RegExp(`\\b(?:checked|inspected|saw)\\b[^.]{0,24}?(?:seat|player)\\s*#?\\s*(\\d)[^.]{0,24}?\\b${CLEAN_WORD}\\b`, 'gi'),
    new RegExp(`\\b(\\d)\\s*[:=-]\\s*(?:clean|innocent|village)`, 'gi'),
  ];
  for (const re of cleanRes) {
    while ((m = re.exec(text)) !== null) push(Number(m[1]), false);
  }
  return out;
}

/** Every seer claim in the log, with the reports each claimant has published. */
function claimsOf(view: View): Claim[] {
  const bySeat = new Map<Seat, Report[]>();
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || e.seat === undefined) continue;
    const claims = SEER_CLAIM.test(e.text);
    const reps = reportsIn(e.text);
    if (!claims && reps.length === 0) continue;
    if (!bySeat.has(e.seat)) bySeat.set(e.seat, []);
    if (claims || bySeat.get(e.seat)!.length > 0 || reps.length > 0) {
      for (const r of reps) {
        r.day = e.day;
        if (!bySeat.get(e.seat)!.some((x) => x.target === r.target)) bySeat.get(e.seat)!.push(r);
      }
      if (claims && !bySeat.has(e.seat)) bySeat.set(e.seat, []);
    }
  }
  return [...bySeat.entries()].map(([seat, reports]) => ({ seat, reports }));
}

interface Belief {
  /** Suspicion per seat; >= 60 reads as known wolf, <= -60 as cleared. */
  score: Map<Seat, number>;
  claims: Claim[];
  /** Claimants whose reports a revealed role has proven true. */
  provenSeer: Set<Seat>;
  /** Claimants whose reports a revealed role has refuted: known wolves. */
  fakeSeer: Set<Seat>;
  revealed: Map<Seat, string>;
  /** Votes already cast in today's vote, in order. */
  todayVotes: { seat: Seat; target: Seat | null }[];
}

/** The village-side reading of the table, rebuilt from the view alone. */
function believe(view: View): Belief {
  const me = view.you.seat;
  const myRole = view.you.role;
  const revealed = new Map<Seat, string>();
  for (const p of view.players) if (p.role !== null) revealed.set(p.seat, p.role);
  const claims = claimsOf(view);
  const provenSeer = new Set<Seat>();
  const fakeSeer = new Set<Seat>();

  for (const c of claims) {
    for (const r of c.reports) {
      const role = revealed.get(r.target);
      if (role === undefined) continue;
      if (r.wolf === (role === 'werewolf')) provenSeer.add(c.seat);
      else fakeSeer.add(c.seat);
    }
  }
  // I am the seer: every other claimant is lying, and my own results are fact.
  if (myRole === 'seer') {
    for (const c of claims) if (c.seat !== me) fakeSeer.add(c.seat);
  }
  // A claimant who named me a wolf while I play for the village is lying.
  if (isVillageRole(myRole)) {
    for (const c of claims) {
      if (c.reports.some((r) => r.target === me && r.wolf)) fakeSeer.add(c.seat);
    }
  }

  const score = new Map<Seat, number>();
  const add = (seat: Seat, w: number) => score.set(seat, (score.get(seat) ?? 0) + w);
  for (const p of view.players) score.set(p.seat, 0);

  // Revealed roles are facts, not suspicions.
  for (const [seat, role] of revealed) {
    score.set(seat, role === 'werewolf' ? 1000 : -1000);
  }
  // My own inspections, when I am the seer, are facts too.
  if (myRole === 'seer' && view.seerResults !== null) {
    for (const r of view.seerResults) score.set(r.seat, r.werewolf ? 1000 : -1000);
  }
  for (const s of fakeSeer) add(s, 1000);

  // Claim reports, weighted by how far the claimant is trusted.
  const livingClaimants = claims.filter((c) => c.seat !== me);
  for (const c of claims) {
    if (c.seat === me) continue;
    const weight = provenSeer.has(c.seat)
      ? 1000
      : fakeSeer.has(c.seat)
        ? 0
        : livingClaimants.length === 1
          ? 6
          : 2.5;
    if (weight === 0) continue;
    for (const r of c.reports) {
      if (revealed.has(r.target)) continue;
      add(r.target, r.wolf ? weight : -weight * 0.7);
    }
    if (!provenSeer.has(c.seat) && !fakeSeer.has(c.seat)) add(c.seat, -0.8);
  }

  // Voting history: pushing a village player out is the loudest wolf tell;
  // voting a revealed wolf out earns trust (a wolf can bus, so it weighs less).
  const exiledOn = new Map<Seat, Set<Seat>>(); // day-vote target -> voters, for exile days
  for (const e of view.log) {
    if (e.kind === 'exile' && e.seat !== undefined) {
      const voters = new Set<Seat>();
      for (const v of view.log) {
        if (v.kind === 'vote' && v.day === e.day && v.target === e.seat && v.seat !== undefined) voters.add(v.seat);
      }
      exiledOn.set(e.seat, voters);
    }
  }
  for (const e of view.log) {
    if (e.kind !== 'vote' || e.seat === undefined || e.target === null || e.target === undefined) continue;
    const role = revealed.get(e.target);
    if (role === undefined) continue;
    if (isVillageRole(role)) add(e.seat, exiledOn.get(e.target)?.has(e.seat) ? 3.2 : 2.1);
    else add(e.seat, -2.2);
  }
  // Speeches: accusing a revealed villager, or shielding a revealed wolf.
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || e.seat === undefined) continue;
    const named = namedSeats(e.text);
    const accuses = /\b(werewolf|wolf|suspicious|lying|liar|fake|evil)\b/i.test(e.text);
    const defends = /\b(innocent|clean|trust|believe|genuine|real seer)\b/i.test(e.text);
    for (const t of named) {
      const role = revealed.get(t);
      if (role === undefined || t === e.seat) continue;
      if (accuses && isVillageRole(role)) add(e.seat, 1.1);
      if (accuses && role === 'werewolf') add(e.seat, -0.9);
      if (defends && role === 'werewolf') add(e.seat, 1.4);
      if (defends && isVillageRole(role)) add(e.seat, -0.5);
    }
  }
  // Wolves hunt together: sharing an exile vote with a revealed wolf is a tell.
  const wolfSeats = new Set([...revealed.entries()].filter(([, r]) => r === 'werewolf').map(([s]) => s));
  for (const [target, voters] of exiledOn) {
    if (!isVillageRole(revealed.get(target))) continue;
    for (const v of voters) if ([...voters].some((o) => wolfSeats.has(o)) && !wolfSeats.has(v)) add(v, 0.8);
  }

  const todayVotes = view.log
    .filter((e) => e.kind === 'vote' && e.day === view.day && e.seat !== undefined)
    .map((e) => ({ seat: e.seat as Seat, target: (e.target ?? null) as Seat | null }));
  return { score, claims, provenSeer, fakeSeer, revealed, todayVotes };
}

/** Living seats in the options, best (least suspicious) last; argmax helper. */
function mostSuspected(b: Belief, seats: readonly Seat[], exclude: ReadonlySet<Seat>): Seat | null {
  let best: Seat | null = null;
  let bestScore = -Infinity;
  for (const s of [...seats].sort((a, c) => a - c)) {
    if (exclude.has(s)) continue;
    const sc = b.score.get(s) ?? 0;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

const aliveSeats = (view: View): Seat[] => view.players.filter((p) => p.alive).map((p) => p.seat);
const nameOf = (view: View, seat: Seat): string => view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;

// ---------------------------------------------------------------------------
// Night decisions
// ---------------------------------------------------------------------------

function decideKill(view: View, options: Seat[], seed: string, game: number): Seat | null {
  const me = view.you.seat;
  const partner = view.you.partner?.seat ?? null;
  const night = view.day;
  // The second wolf to vote sees the first's pick: confirm it, so the kill lands.
  if (view.wolfVotes !== null) {
    const partnerPick = view.wolfVotes.find((v) => v.night === night && v.seat !== me && v.target !== null);
    if (partnerPick !== undefined && options.includes(partnerPick.target as Seat)) {
      return partnerPick.target as Seat;
    }
  }
  const b = believe(view);
  const doctorDead = [...b.revealed.values()].includes('doctor');
  const seerDead = [...b.revealed.values()].includes('seer');
  void seerDead;
  // The village's most trusted living non-wolf: what the village would exile.
  const villageTarget = mostSuspected(b, aliveSeats(view), new Set([me, partner ?? -1]));
  let best: Seat | null = null;
  let bestScore = -Infinity;
  for (const s of [...options].sort((a, c) => a - c)) {
    let sc = 0;
    const claim = b.claims.find((c) => c.seat === s);
    if (claim !== undefined && b.provenSeer.has(s)) sc += 6;
    else if (claim !== undefined) sc += 3.5;
    // Seats that named me or my partner as wolves, or voted for us, die first.
    for (const e of view.log) {
      if (e.kind === 'speech' && e.seat === s && typeof e.text === 'string') {
        const named = namedSeats(e.text);
        if ((named.includes(me) || (partner !== null && named.includes(partner))) && /\b(werewolf|wolf|suspicious|lying)\b/i.test(e.text)) sc += 2.5;
      }
      if (e.kind === 'vote' && e.seat === s && (e.target === me || e.target === partner)) sc += 2;
    }
    // A trusted voice (the village keeps following their votes) is worth removing.
    sc += Math.max(0, -(b.score.get(s) ?? 0)) * 0.25;
    // A claimed seer is likely under the doctor's wing while the doctor lives.
    if (claim !== undefined && !doctorDead) sc -= 2.5;
    // Do not waste the night on the seat the village will exile for us.
    if (s === villageTarget) sc -= 1.5;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  if (best === null || bestScore <= -2) {
    // Nothing stands out: take a quiet seat the village is not watching.
    const quiet = [...options].sort((a, c) => (b.score.get(a) ?? 0) - (b.score.get(c) ?? 0));
    return quiet.length > 0 ? seededPick(seed, `kill:${game}:${night}`, quiet.slice(0, Math.min(3, quiet.length))) : null;
  }
  return best;
}

function decideProtect(view: View, options: Seat[]): Seat | null {
  const b = believe(view);
  const pick = (s: Seat | null): Seat | null => (s !== null && options.includes(s) ? s : null);
  // A proven seer is the wolves' first target; an unproven claimant is second.
  for (const c of b.claims) if (b.provenSeer.has(c.seat)) return pick(c.seat) ?? null;
  for (const c of b.claims) {
    if (c.reports.some((r) => r.wolf) && !b.fakeSeer.has(c.seat)) {
      const p = pick(c.seat);
      if (p !== null) return p;
    }
  }
  // Then the village player under the most pressure today: wolves hunt leaders,
  // and a player the table is turning on may be exactly who they kill tonight.
  const pressure = new Map<Seat, number>();
  for (const e of view.log) {
    if (e.day !== view.day) continue;
    if (e.kind === 'vote' && e.target !== null && e.target !== undefined) {
      pressure.set(e.target, (pressure.get(e.target) ?? 0) + 1);
    }
  }
  let best: Seat | null = null;
  let bestN = 0;
  for (const s of [...options].sort((a, c) => a - c)) {
    const n = pressure.get(s) ?? 0;
    if (n > bestN && (b.score.get(s) ?? 0) < 40) {
      bestN = n;
      best = s;
    }
  }
  if (best !== null) return best;
  // Otherwise cover the least suspected living voice: the trusted are hunted.
  let calm: Seat | null = null;
  let calmScore = Infinity;
  for (const s of [...options].sort((a, c) => a - c)) {
    const sc = b.score.get(s) ?? 0;
    if (sc < calmScore) {
      calmScore = sc;
      calm = s;
    }
  }
  return calm;
}

function decideInspect(view: View, options: Seat[]): Seat | null {
  const b = believe(view);
  const checked = new Set((view.seerResults ?? []).map((r) => r.seat));
  const fresh = options.filter((s) => !checked.has(s));
  const pool = fresh.length > 0 ? fresh : options;
  // Verify the loudest suspicion first; a claimant I have not read is a priority
  // only while their seat is unread — I already know a counter-claimant lies.
  return mostSuspected(b, pool, new Set());
}

// ---------------------------------------------------------------------------
// Day decisions: votes
// ---------------------------------------------------------------------------

function decideVote(view: View, options: Seat[]): Seat | null {
  const me = view.you.seat;
  const role = view.you.role;
  const b = believe(view);

  if (role === 'werewolf') {
    const partner = view.you.partner?.seat ?? null;
    const exclude = new Set<Seat>([me]);
    // Bus a partner the table has effectively proven (a credible claim naming
    // them plus the votes already moving): blending in beats a lost defence.
    if (partner !== null && options.includes(partner)) {
      const namedByClaim = b.claims.some(
        (c) => c.seat !== me && !b.fakeSeer.has(c.seat) && c.reports.some((r) => r.target === partner && r.wolf),
      );
      const votesOnPartner = b.todayVotes.filter((v) => v.target === partner).length;
      const accused = view.log.filter(
        (e) => e.kind === 'speech' && e.day === view.day && typeof e.text === 'string' && namedSeats(e.text).includes(partner),
      ).length;
      if ((namedByClaim && votesOnPartner >= 1) || votesOnPartner >= 3 || (namedByClaim && accused >= 2)) {
        return partner;
      }
      exclude.add(partner);
    }
    // Join the moving bandwagon against a villager when one exists.
    const tally = new Map<Seat, number>();
    for (const v of b.todayVotes) {
      if (v.target !== null && !exclude.has(v.target)) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
    }
    let wagon: Seat | null = null;
    let wagonN = 0;
    for (const [s, n] of tally) if (n > wagonN && options.includes(s)) { wagonN = n; wagon = s; }
    if (wagon !== null && wagonN >= 2) return wagon;
    // Else push the villager the village itself suspects most.
    const target = mostSuspected(b, options, exclude);
    if (target !== null) return target;
    return wagon;
  }

  // Village side: a known wolf first (my own reading, a proven seer, a fake).
  const known = options.filter((s) => (b.score.get(s) ?? 0) >= 60);
  if (known.length > 0) {
    // Pile onto the known wolf the table is already exiling, else the first.
    const tally = new Map<Seat, number>();
    for (const v of b.todayVotes) if (v.target !== null) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
    known.sort((a, c) => (tally.get(c) ?? 0) - (tally.get(a) ?? 0) || a - c);
    return known[0]!;
  }
  const target = mostSuspected(b, options, new Set([me]));
  if (target === null) return null;
  // Never exile a seat I hold cleared when any other choice exists.
  if ((b.score.get(target) ?? 0) <= -60) {
    const rest = options.filter((s) => (b.score.get(s) ?? 0) > -60);
    if (rest.length > 0) return mostSuspected(b, rest, new Set([me]));
    return null; // everyone reads clean: abstain rather than exile a clear.
  }
  return target;
}

// ---------------------------------------------------------------------------
// Day decisions: speech
// ---------------------------------------------------------------------------

function mySpeechesToday(view: View): number {
  return view.log.filter((e) => e.kind === 'speech' && e.day === view.day && e.seat === view.you.seat).length;
}

function seerReportText(view: View): string {
  const results = view.seerResults ?? [];
  const parts = results.map(
    (r) => `night ${r.night} I checked seat ${r.seat} (${nameOf(view, r.seat)}): ${r.werewolf ? 'WEREWOLF' : 'clean'}`,
  );
  return parts.length > 0 ? parts.join('; ') : 'I have no checks yet';
}

function decideSpeak(view: View, maxChars: number, seed: string, game: number): string | null {
  const me = view.you.seat;
  const role = view.you.role;
  const day = view.day;
  const b = believe(view);
  const spoken = mySpeechesToday(view);
  const alive = aliveSeats(view);
  const say = (t: string): string | null => {
    const f = fold(t, maxChars);
    return f === '' ? null : f;
  };

  // ------------------------------------------------------------- werewolf
  if (role === 'werewolf') {
    const partner = view.you.partner?.seat ?? null;
    const seerRevealedDead = [...b.revealed.entries()].some(([, r]) => r === 'seer');
    const claimants = b.claims.filter((c) => c.seat !== me);
    const namedMe = claimants.find((c) => c.reports.some((r) => r.target === me && r.wolf));
    const namedPartner = partner !== null
      ? claimants.find((c) => c.reports.some((r) => r.target === partner && r.wolf))
      : undefined;
    const iClaimed = b.claims.some((c) => c.seat === me);

    // Caught by a claimant: counter-claim the seer's seat at once.
    if (namedMe !== undefined && spoken === 0) {
      return say(
        `Seat ${namedMe.seat} is lying. I am the seer. Last night I checked seat ${namedMe.seat}: WEREWOLF. ` +
        `A real seer does not open by inventing a wolf; a wolf does, to burn a day. Vote seat ${namedMe.seat}.`,
      );
    }
    // The real seer is dead and unclaimed: take the seat when one mislynch plus
    // tonight's kill reaches parity (6 or fewer alive, partner living).
    if (
      seerRevealedDead && claimants.length === 0 && !iClaimed && spoken === 0 &&
      alive.length <= 6 && partner !== null && view.you.partner!.alive && day >= 2
    ) {
      const exclude = new Set<Seat>([me, partner]);
      const trusted = [...alive]
        .filter((s) => !exclude.has(s))
        .sort((a, c) => (b.score.get(a) ?? 0) - (b.score.get(c) ?? 0) || a - c)[0];
      if (trusted !== undefined) {
        const deadVillager = [...b.revealed.entries()].find(([, r]) => isVillageRole(r) && r !== 'seer');
        const cover = deadVillager !== undefined
          ? `Earlier I checked seat ${deadVillager[0]}: clean, as their reveal showed. `
          : '';
        return say(
          `I am the seer, and I should have spoken sooner. ${cover}Last night I checked seat ${trusted}: WEREWOLF. ` +
          `That is today's exile; the village cannot afford another miss.`,
        );
      }
    }
    if (iClaimed) return null; // A claimed wolf-seer says its piece once.
    if (spoken >= 1) return null;
    // Blend in: a mild, evidence-shaped suspicion of a villager, never partner.
    const exclude = new Set<Seat>([me]);
    if (partner !== null) exclude.add(partner);
    const target = mostSuspected(b, alive, exclude);
    if (target === null || day === 1) {
      return day === 1
        ? say(`Day 1: I have little to go on yet. I am watching the votes; a wolf's vote usually hides in the middle of a pile.`)
        : null;
    }
    if (namedPartner !== undefined) {
      // Deflect once, softly, toward the claimant's other reading.
      return say(
        `I am not convinced by seat ${namedPartner.seat}'s claim yet. Before we exile on one voice, weigh the votes: seat ${target} has been voting with every pile that hit a villager.`,
      );
    }
    return say(
      `My suspicion is seat ${target} (${nameOf(view, target)}). Their votes have landed on village players, and their accusations point away from every revealed wolf. I will vote there unless the seer speaks.`,
    );
  }

  // ----------------------------------------------------------------- seer
  if (role === 'seer') {
    const results = view.seerResults ?? [];
    const foundWolf = results.find((r) => r.werewolf && view.players.find((p) => p.seat === r.seat)?.alive);
    const counter = b.claims.find((c) => c.seat !== me);
    const votesOnMe = b.todayVotes.filter((v) => v.target === me).length;
    const reveal =
      foundWolf !== undefined || counter !== undefined || day >= 3 || votesOnMe >= 2;
    if (!reveal) {
      if (spoken >= 1) return null;
      // Stay hidden, but push the table with ordinary deduction.
      const target = mostSuspected(b, alive, new Set([me]));
      if (target === null) return null;
      return say(
        `No claim from me yet. On the votes alone, seat ${target} (${nameOf(view, target)}) reads worst to me; I want to hear them before the vote.`,
      );
    }
    if (spoken >= 1) return null;
    const counterLine = counter !== undefined
      ? ` Seat ${counter.seat} also claims the seer: there is only one, and it is not them.`
      : '';
    const wolfLine = foundWolf !== undefined
      ? ` Exile seat ${foundWolf.seat} today: that is a certain wolf.`
      : '';
    return say(`I am the seer. ${seerReportText(view)}.${counterLine}${wolfLine} Doctor, I will need you tonight.`);
  }

  // ------------------------------------------------------- doctor / villager
  if (spoken >= 1) return null;
  const target = mostSuspected(b, alive, new Set([me]));
  const knownWolf = alive.find((s) => s !== me && (b.score.get(s) ?? 0) >= 60);
  if (knownWolf !== undefined) {
    const why = b.fakeSeer.has(knownWolf)
      ? 'their seer claim was disproven by a revealed role'
      : 'the evidence on them is settled';
    return say(`Seat ${knownWolf} (${nameOf(view, knownWolf)}) is a wolf: ${why}. Vote seat ${knownWolf}; do not split the pile.`);
  }
  // A proven seer's living named wolf is already handled above; back a lone
  // claimant's named wolf when nothing contradicts it.
  const loneClaim = b.claims.length === 1 ? b.claims[0] : undefined;
  if (loneClaim !== undefined && loneClaim.seat !== me) {
    const named = loneClaim.reports.find((r) => r.wolf && alive.includes(r.target) && r.target !== me);
    if (named !== undefined) {
      return say(
        `Seat ${loneClaim.seat} claims the seer and names seat ${named.target} a wolf. No counter-claim has come. I will back the claim today: vote seat ${named.target}.`,
      );
    }
  }
  if (target === null) return null;
  if (day === 1) {
    return seededPick(seed, `d1:${game}`, [
      say('Day 1: too little is proven for a hard accusation. My eye is on whoever votes without giving a reason.'),
      say('Day 1: I will judge by votes, not volume. Quiet seats that pile on late are my suspects.'),
    ]);
  }
  const sc = b.score.get(target) ?? 0;
  if (sc <= 0.5) {
    return say('Nothing is proven yet. I lean on the voting record over speeches; if forced, I vote the least consistent seat.');
  }
  return say(
    `My vote leans seat ${target} (${nameOf(view, target)}). Their record — votes on village players and accusations that miss every revealed wolf — is the worst at this table.`,
  );
}

// ---------------------------------------------------------------------------
// The run: one request at a time, in the env's order
// ---------------------------------------------------------------------------

export interface RunOptions {
  envUrl?: string;
  seed?: string;
  log?: (line: string) => void;
}

export async function run(o: RunOptions = {}): Promise<{ decisions: number }> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const seed = o.seed ?? env.MAKEFUN_TRIAL_SEED ?? '';
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  let decisions = 0;

  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  const decide = (p: Pending): Record<string, unknown> => {
    const view = p.view;
    const options = p.options ?? [];
    switch (p.decision) {
      case 'kill': {
        const t = decideKill(view, options, seed, p.game);
        return { game: p.game, decision: 'kill', target: t };
      }
      case 'protect': {
        const t = decideProtect(view, options);
        return { game: p.game, decision: 'protect', target: t };
      }
      case 'inspect': {
        const t = decideInspect(view, options);
        return { game: p.game, decision: 'inspect', target: t };
      }
      case 'vote': {
        const t = decideVote(view, options);
        return { game: p.game, decision: 'vote', target: t };
      }
      case 'speak': {
        const text = decideSpeak(view, p.max_chars ?? 500, seed, p.game);
        return text === null
          ? { game: p.game, decision: 'speak', pass: true }
          : { game: p.game, decision: 'speak', text };
      }
    }
  };

  const fallbackFor = (p: Pending): Record<string, unknown> =>
    p.decision === 'speak'
      ? { game: p.game, decision: 'speak', pass: true }
      : { game: p.game, decision: p.decision, target: null };

  for (;;) {
    const r = await post('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    for (const p of obs.pending) {
      decisions += 1;
      let act: Record<string, unknown>;
      try {
        act = decide(p);
      } catch {
        act = fallbackFor(p);
      }
      const posted = await post('/act', act);
      if (posted.status === 400) {
        await post('/act', fallbackFor(p));
      }
    }
  }
  log(`strategist: ${decisions} decisions, no model calls`);
  return { decisions };
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`strategist: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
