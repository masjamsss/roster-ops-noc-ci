// Day staffing levels, as the OM reads them:
//   weekday:  IDEAL (>= ideal on every shift, e.g. 2-2-1)
//             CUKUP (above minimum somewhere, below ideal, e.g. 2-1-1 or 1-2-1)
//             MINIMAL (exactly the minimum on every shift, e.g. 1-1-1)
//             KURANG (a shift below minimum)
//   weekend / tanggal merah / cuti bersama: OK (exact), LEBIH (more), KURANG (less)

export function dayStatus(counts, isSpecial, coverage, shiftIds) {
  const policy = isSpecial ? coverage.special : coverage.weekday;
  if (shiftIds.some((id) => counts[id] < policy.minimum[id])) return "KURANG";
  if (isSpecial) return shiftIds.some((id) => counts[id] > policy.preferred[id]) ? "LEBIH" : "OK";
  if (shiftIds.every((id) => counts[id] >= policy.preferred[id])) return "IDEAL";
  if (shiftIds.every((id) => counts[id] === policy.minimum[id])) return "MINIMAL";
  return "CUKUP";
}

// Cost of staffing a weekday below the ideal: each missing person is cheap
// ("cukup" is fine) and dropping to the bare minimum is expensive. Morning
// traffic is higher, so Shift 1 never has fewer people than Shift 2 (1-2-1
// is almost as bad as 1-1-1, but still better than sending the person home).
export function staffingPenalty(counts, isSpecial, coverage, shiftIds, weights) {
  if (isSpecial) return 0;
  const policy = coverage.weekday;
  let penalty = 0;
  if ((counts["1"] ?? 0) < (counts["2"] ?? 0)) penalty += (weights.shift1BelowShift2 ?? 0) * (counts["2"] - counts["1"]);
  let missing = 0;
  for (const id of shiftIds) if (counts[id] < policy.preferred[id]) missing += policy.preferred[id] - counts[id];
  if (missing === 0) return penalty;
  penalty += missing * weights.weekdayShortPerPerson;
  if (shiftIds.every((id) => counts[id] === policy.minimum[id])) penalty += weights.weekdayMinimal;
  return penalty;
}
