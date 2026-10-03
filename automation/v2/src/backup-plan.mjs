// What happens when one person cannot come to a shift at short notice.
// Overtime is at most `overtimeHours` per person and never a whole shift: the
// previous shift stays longer and/or the next shift comes in earlier, and both
// keep the minimum rest before their next shift and after their previous one.
// Hours count from 00:00 of timeline day 0; a timeline is one code per day.
import { parseClock } from "./date-utils.mjs";

function windowOf(code, dayIndex, shiftById) {
  const shift = shiftById.get(code);
  if (!shift || dayIndex < 0) return null;
  const start = dayIndex * 24 + parseClock(shift.start);
  let end = dayIndex * 24 + parseClock(shift.end);
  if (end <= start) end += 24;
  return { start, end };
}

function workWindows(codes, shiftById) {
  return (codes ?? []).map((code, dayIndex) => windowOf(code, dayIndex, shiftById)).filter(Boolean);
}

// Parts of `range` not covered by any of `covers`.
function subtract(range, covers) {
  let open = [range];
  for (const cover of covers) {
    open = open.flatMap((part) => {
      if (cover.end <= part.from || cover.start >= part.to) return [part];
      const pieces = [];
      if (cover.start > part.from) pieces.push({ from: part.from, to: cover.start });
      if (cover.end < part.to) pieces.push({ from: cover.end, to: part.to });
      return pieces;
    });
  }
  return open;
}

export function overtimeCover({ dayIndex, shiftId, timeline, members, shifts, minimumRestHours, overtimeHours }) {
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const onShift = members.filter((member) => timeline[member.id]?.[dayIndex] === shiftId);
  const people = onShift.map((member) => member.name);
  if (onShift.length >= 2) return { safe: true, people, gap: null, extension: null, early: null, uncovered: [] };

  const target = windowOf(shiftId, dayIndex, shiftById);
  const others = members.filter((member) => !onShift.includes(member));
  const busy = others.flatMap((member) => workWindows(timeline[member.id], shiftById));
  const open = subtract({ from: target.start, to: target.end }, busy);
  if (open.length === 0) return { safe: true, people, gap: null, extension: null, early: null, uncovered: [] };
  const gap = { from: open[0].from, to: open.at(-1).to };

  // Only people allowed to work the missing shift cover its hours (e.g. no
  // night hours for someone who may not work Shift 3).
  const allowed = (member) => !member.eligibleShifts || member.eligibleShifts.includes(shiftId);
  let extension = null;
  let early = null;
  for (const member of others.filter(allowed)) {
    const own = workWindows(timeline[member.id], shiftById);
    const index = own.findIndex((window) => window.end === gap.from);
    if (index >= 0) {
      const next = own[index + 1];
      const hours = Math.min(overtimeHours, next ? next.start - minimumRestHours - gap.from : overtimeHours);
      if (hours > 0 && (!extension || hours > extension.to - extension.from)) extension = { id: member.id, name: member.name, from: gap.from, to: gap.from + hours };
    }
    const later = own.findIndex((window) => window.start === gap.to);
    if (later >= 0) {
      const previous = own[later - 1];
      const hours = Math.min(overtimeHours, previous ? gap.to - (previous.end + minimumRestHours) : overtimeHours);
      if (hours > 0 && (!early || hours > early.to - early.from)) early = { id: member.id, name: member.name, from: gap.to - hours, to: gap.to };
    }
  }
  const covers = [extension, early].filter(Boolean).map((item) => ({ start: item.from, end: item.to }));
  return { safe: false, people, gap, extension, early, uncovered: subtract(gap, covers).flatMap((part) => subtract(part, busy.map((w) => w))) };
}
