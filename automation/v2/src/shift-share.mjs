// Shift 1 / Shift 2 for the people who also work Shift 3 (user, 28 Oct 2026:
// Rudi had 10 Shift 1 and 1 Shift 2 in November while Agus had 6 and 7).
// They cannot be half and half like the day-only members: on 2-1-1 weekdays
// Shift 1 needs more people, and the day-only members are already balanced. So
// each person's Shift 2 days are compared with a fair share: the group's share
// of Shift 2 among all its Shift 1+2 days, times their own Shift 1+2 days.
// One definition for the search (objective.mjs), the quality review and the
// Excel formula (excel-checks.mjs).

export function countsForShift2Share(member) {
  return !member.dayOnly && member.eligibleShifts.includes("1") && member.eligibleShifts.includes("2");
}

// Group totals of rows { s1, s2 }: Shift 2 days and Shift 1+2 days.
export function shift2Totals(rows) {
  let shift2 = 0;
  let dayShifts = 0;
  for (const row of rows) {
    shift2 += row.s2;
    dayShifts += row.s1 + row.s2;
  }
  return { shift2, dayShifts };
}

// Shift 2 days the person's fair share would give.
export function fairShift2(row, totals) {
  return totals.dayShifts > 0 ? ((row.s1 + row.s2) * totals.shift2) / totals.dayShifts : 0;
}

// The quality review: more than 1.5 days from the fair share. Written without
// division (|2 × (s2 × D − S × d)| > 3 × D) so the Excel formula gives exactly the same answer.
export function shift2Uneven(row, totals) {
  const { shift2, dayShifts } = totals;
  return dayShifts > 0 && Math.abs(2 * (row.s2 * dayShifts - shift2 * (row.s1 + row.s2))) > 3 * dayShifts;
}

// A day with Dispensasi Shift 1 or Shift 2 (user, 28 Oct) is left out of the
// Shift 1 / Shift 2 split, for everyone: an approved exemption, so the person
// does not make it up later. `shifts` = that day's Dispensasi shifts (a Set, or
// the sorted string of the Excel helper row).
export function excusedFromSplit(shifts) {
  if (!shifts) return false;
  return typeof shifts === "string" ? /[12]/.test(shifts) : shifts.has("1") || shifts.has("2");
}
