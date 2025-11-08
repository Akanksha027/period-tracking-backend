export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeOffset(offset) {
  if (typeof offset === 'string') {
    const parsed = parseInt(offset, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    return offset;
  }
  return 0;
}

export function getLocalDayNumber(dateInput, timezoneOffsetMinutes = 0) {
  if (!dateInput) return null;
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  return Math.floor((date.getTime() + offsetMs) / MS_PER_DAY);
}

export function fromLocalDayNumber(dayNumber, timezoneOffsetMinutes = 0) {
  if (!Number.isFinite(dayNumber)) return null;
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  const utcMs = dayNumber * MS_PER_DAY - offsetMs;
  return new Date(utcMs);
}

export function inferTimezoneOffsetFromPeriods(periods) {
  if (!Array.isArray(periods)) return 0;
  for (const period of periods) {
    if (!period?.startDate) continue;
    const match = String(period.startDate).match(/T(\d{2}):(\d{2})/);
    if (!match) continue;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) continue;
    const totalMinutes = hours * 60 + minutes;
    if (totalMinutes === 0) {
      return 0;
    }
    if (totalMinutes <= 12 * 60) {
      return totalMinutes;
    }
    return totalMinutes - 24 * 60;
  }
  return 0;
}

export function calculateCycleInfo(periods, settings, options = {}) {
  const { today = new Date(), timezoneOffsetMinutes = 0 } = options;

  if (!periods || periods.length === 0) {
    return null;
  }

  const offset = normalizeOffset(timezoneOffsetMinutes);

  const sortedPeriods = [...periods].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  );

  const lastPeriod = sortedPeriods[0];
  if (!lastPeriod?.startDate) {
    return null;
  }

  const averagePeriodLength = settings?.periodDuration ?? settings?.averagePeriodLength ?? 5;
  const periodLength = Math.max(1, averagePeriodLength);
  const avgCycleLength = Math.max(1, settings?.averageCycleLength ?? 28);

  const todayDayNumber = getLocalDayNumber(today, offset);
  const periodStartDayNumber = getLocalDayNumber(lastPeriod.startDate, offset);

  if (todayDayNumber === null || periodStartDayNumber === null) {
    return null;
  }

  let periodEndDayNumber = getLocalDayNumber(lastPeriod.endDate, offset);
  if (periodEndDayNumber === null) {
    periodEndDayNumber = periodStartDayNumber + periodLength - 1;
  }

  const nextPeriodDayNumber = periodStartDayNumber + avgCycleLength;

  if (todayDayNumber >= periodStartDayNumber && todayDayNumber <= periodEndDayNumber) {
    const daysInPeriod = todayDayNumber - periodStartDayNumber + 1;
    return {
      cycleDay: daysInPeriod,
      phase: 'Menstrual',
      phaseDescription: `Day ${daysInPeriod} of period`,
      isOnPeriod: true,
      nextPeriodDayNumber,
      nextPeriodDate: fromLocalDayNumber(nextPeriodDayNumber, offset),
      todayDayNumber,
      periodStartDayNumber,
      periodEndDayNumber,
      avgCycleLength,
    };
  }

  const daysSincePeriodEnd = todayDayNumber - periodEndDayNumber;
  if (daysSincePeriodEnd < 0) {
    return null;
  }

  const currentCycleDay = daysSincePeriodEnd + 1 + periodLength;
  const ovulationDay = Math.max(periodLength + 1, Math.round(avgCycleLength / 2));

  let phase = 'Follicular';
  if (currentCycleDay <= periodLength) {
    phase = 'Menstrual';
  } else if (currentCycleDay < ovulationDay) {
    phase = 'Follicular';
  } else if (currentCycleDay === ovulationDay) {
    phase = 'Ovulation';
  } else {
    phase = 'Luteal';
  }

  return {
    cycleDay: currentCycleDay,
    phase,
    phaseDescription: `Day ${currentCycleDay} of ${avgCycleLength}-day cycle (${phase} Phase)`
      ,
    isOnPeriod: false,
    nextPeriodDayNumber,
    nextPeriodDate: fromLocalDayNumber(nextPeriodDayNumber, offset),
    todayDayNumber,
    periodStartDayNumber,
    periodEndDayNumber,
    avgCycleLength,
  };
}

