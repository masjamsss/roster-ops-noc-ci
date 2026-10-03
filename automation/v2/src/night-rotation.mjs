// Shift 3 (night) rotation inside the search. The rotation keeps September's
// order: the person whose last night was longest ago goes next. Anyone who
// cannot start (too many days in a row, still recovering, leave, not active)
// is skipped but keeps their place at the front of the queue.
import { isOffLike } from "./codes.mjs";
import { parseClock } from "./date-utils.mjs";
import { isActive } from "./rules.mjs";

export function initialNightState(historyCodesById, queue, nightShiftId) {
  for (const id of queue) {
    const codes = historyCodesById[id] ?? [];
    if (codes.length > 0 && codes.at(-1) === nightShiftId) {
      let length = 0;
      for (let index = codes.length - 1; index >= 0 && codes[index] === nightShiftId; index -= 1) length += 1;
      return { owner: id, length, queue: [...queue] };
    }
  }
  return { owner: null, length: 0, queue: [...queue] };
}

function moveToBack(queue, id) {
  return [...queue.filter((item) => item !== id), id];
}

function canStartBlock(id, { day, fixedToday, fixedTomorrow, states, memberById, ctx }) {
  const member = memberById.get(id);
  const nightId = ctx.nightShiftId;
  const rules = ctx.rules;
  if (!member || !member.eligibleShifts.includes(nightId) || !isActive(member, day.date)) return false;
  if (fixedToday[id] !== undefined && fixedToday[id] !== nightId) return false;
  if (rules.nightBlock.min > 1 && day.hasTomorrow) {
    if (day.nextDate && !isActive(member, day.nextDate)) return false;
    if (fixedTomorrow[id] !== undefined && fixedTomorrow[id] !== nightId) return false;
  }
  const state = states.get(id);
  if (state.previousCode === nightId) return false;
  if ((state.daysSinceSick ?? 99) + 1 <= (rules.nightFreeDaysAfterSick ?? 0)) return false;
  if (state.lastWorkWasNight && isOffLike(state.previousCode) && state.restStreak < rules.nightRecoveryOffDays) return false;
  if (state.workStreak + rules.nightBlock.min > rules.maxConsecutiveWorkDays) return false;
  if (state.lastWorkEnd !== null) {
    const nightStart = day.dayIndex * 24 + parseClock(ctx.shiftById.get(nightId).start);
    if (nightStart - state.lastWorkEnd < rules.minimumRestHours) return false;
  }
  return true;
}

// Who may hold Shift 3 today, given the rotation state of one search node.
// Returns [{ owner, night }] where `night` is the rotation state after today.
export function nightOptions({ night, day, fixedToday, fixedTomorrow, states, members, ctx, memberById }) {
  const nightId = ctx.nightShiftId;
  const block = ctx.rules.nightBlock;
  const byId = memberById ?? new Map(members.map((member) => [member.id, member]));

  const requested = members.filter((member) => fixedToday[member.id] === nightId).map((member) => member.id);
  if (requested.length > 1) return [];
  if (requested.length === 1) {
    const id = requested[0];
    // A block never crosses into a new month on its own, but a Shift 3 requested
    // on the 1st for the person who ended last month on nights continues that
    // block (the 3-night maximum still applies).
    if (id === night.owner && night.length > 0) {
      return [{ owner: id, night: { owner: id, length: night.length + 1, queue: night.queue } }];
    }
    return [{ owner: id, night: { owner: id, length: 1, queue: moveToBack(night.queue, id) } }];
  }

  const options = [];
  const continuing = night.owner !== null && night.length > 0 && !day.isFirstOfMonth;
  if (continuing) {
    const owner = byId.get(night.owner);
    const fixed = fixedToday[night.owner];
    const canContinue = night.length < block.max && owner && isActive(owner, day.date) && (fixed === undefined || fixed === nightId);
    if (canContinue) {
      const option = { owner: night.owner, night: { owner: night.owner, length: night.length + 1, queue: night.queue } };
      if (night.length < block.min) return [option];
      options.push(option);
    }
  }

  if (day.isLastOfMonth && block.min > 1) return options;
  const context = { day, fixedToday, fixedTomorrow, states, memberById: byId, ctx };
  // The first `choices` available people in queue order may start the block
  // (default 2): fairness decides between neighbours, and whoever is passed
  // over stays at the front for the next block, so the rotation stays orderly.
  const choices = ctx.nightChoices ?? 1;
  for (const id of night.queue) {
    if (options.filter((option) => option.night.length === 1).length >= choices) break;
    if (canStartBlock(id, context)) options.push({ owner: id, night: { owner: id, length: 1, queue: moveToBack(night.queue, id) } });
  }
  return options;
}
