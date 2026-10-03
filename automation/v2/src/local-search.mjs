// Polishes the search result with two kinds of moves:
// - swap two people's codes on 1-3 consecutive days (the counts per shift stay);
// - change one person's day on a weekday: day off <-> Shift 1/2, or Shift 1 <->
//   Shift 2, only while every shift stays between its minimum and ideal count
//   (weekends and holidays are exact, so they are left alone). In the six-month
//   backtest this found 2 extra IDEAL weekdays in November that swaps cannot.
// Neither touches Shift 3, leave, requests or inactive days. A move is kept only
// if every rule still holds through the look-ahead and the objective strictly
// improves; each pass applies the best move found.
import { scoreSchedule } from "./objective.mjs";

function swap(codes, a, b, start, length) {
  for (let d = start; d < start + length; d += 1) {
    const held = codes[a][d];
    codes[a][d] = codes[b][d];
    codes[b][d] = held;
  }
}

export function improveBySwaps({ codes, members, days, fixed, initialStates, ctx, config, env }) {
  const nightId = ctx.nightShiftId;
  const dayShiftIds = ctx.shiftIds.filter((id) => id !== nightId);
  const score = () => scoreSchedule({ codes, members, days, initialStates, ctx, config, fixed, env });
  let current = score();
  if (!current.valid) throw new Error("Hasil pencarian tidak valid sebelum perbaikan (bug program).");
  const log = [];

  const swappable = (a, b, start, length) => {
    let differs = false;
    for (let d = start; d < start + length; d += 1) {
      const codeA = codes[a][d];
      const codeB = codes[b][d];
      if (codeA === nightId || codeB === nightId) return false;
      if (fixed[d][members[a].id] !== undefined || fixed[d][members[b].id] !== undefined) return false;
      if (ctx.shiftIds.includes(codeB) && !members[a].eligibleShifts.includes(codeB)) return false;
      if (ctx.shiftIds.includes(codeA) && !members[b].eligibleShifts.includes(codeA)) return false;
      if (codeA !== codeB) differs = true;
    }
    return differs;
  };

  for (let pass = 1; pass <= config.localSearch.maxPasses; pass += 1) {
    let best = null;
    for (let start = 0; start < env.publishedCount; start += 1) {
      for (const length of [1, 2, 3]) {
        if (start + length > env.publishedCount) break;
        for (let a = 0; a < members.length; a += 1) {
          for (let b = a + 1; b < members.length; b += 1) {
            if (!swappable(a, b, start, length)) continue;
            swap(codes, a, b, start, length);
            const candidate = score();
            if (candidate.valid && candidate.total < (best ? best.total : current.total) - 1e-9) best = { a, b, start, length, total: candidate.total };
            swap(codes, a, b, start, length);
          }
        }
      }
      const policy = days[start].isSpecial ? null : config.coverage.weekday;
      if (!policy) continue;
      const countOn = (id) => codes.reduce((count, row) => count + (row[start] === id ? 1 : 0), 0);
      for (let a = 0; a < members.length; a += 1) {
        const code = codes[a][start];
        if (fixed[start][members[a].id] !== undefined || (code !== "H" && !dayShiftIds.includes(code))) continue;
        for (const next of ["H", ...dayShiftIds]) {
          if (next === code || (next !== "H" && !members[a].eligibleShifts.includes(next))) continue;
          if (code !== "H" && countOn(code) - 1 < policy.minimum[code]) continue;
          if (next !== "H" && countOn(next) + 1 > policy.preferred[next]) continue;
          codes[a][start] = next;
          const candidate = score();
          if (candidate.valid && candidate.total < (best ? best.total : current.total) - 1e-9) best = { a, start, change: [code, next], total: candidate.total };
          codes[a][start] = code;
        }
      }
    }
    if (!best) break;
    if (best.change) codes[best.a][best.start] = best.change[1];
    else swap(codes, best.a, best.b, best.start, best.length);
    log.push({
      pass,
      members: best.change ? [members[best.a].id] : [members[best.a].id, members[best.b].id],
      dates: days.slice(best.start, best.start + (best.length ?? 1)).map((day) => day.date),
      ...(best.change ? { change: best.change } : {}),
      before: Math.round(current.total),
      after: Math.round(best.total)
    });
    current = score();
  }
  return { codes, score: current.total, log };
}
