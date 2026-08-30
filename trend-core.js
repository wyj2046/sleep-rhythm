(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SleepTrendCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function timeToMinutes(value) {
    const [hours, minutes] = String(value).split(":").map(Number);
    return hours * 60 + minutes;
  }

  function isValidTimeString(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value));
    if (!match) return false;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  }

  function isValidDateString(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }

  function dedupeEntriesByDate(entries) {
    const byDate = new Map();
    entries.forEach((entry) => {
      if (!entry || !entry.id || !isValidDateString(entry.date) || !isValidTimeString(entry.bedTime) || !isValidTimeString(entry.wakeTime)) {
        return;
      }
      const current = byDate.get(entry.date);
      const currentUpdatedAt = Date.parse((current && current.updatedAt) || "") || 0;
      const nextUpdatedAt = Date.parse(entry.updatedAt || "") || 0;
      if (!current || nextUpdatedAt >= currentUpdatedAt) byDate.set(entry.date, entry);
    });
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  function normalizeNightTime(value, kind) {
    const minutes = timeToMinutes(value);
    if (kind === "bed") return minutes < 12 * 60 ? minutes + 24 * 60 : minutes;
    return minutes < 18 * 60 ? minutes + 24 * 60 : minutes;
  }

  function sleepDuration(bedTime, wakeTime) {
    const bed = normalizeNightTime(bedTime, "bed");
    const wake = normalizeNightTime(wakeTime, "wake");
    return wake >= bed ? wake - bed : wake + 24 * 60 - bed;
  }

  function isValidTargetConfig(target) {
    const threshold = Number(target && target.driftThreshold);
    return Boolean(
      target &&
        isValidTimeString(target.targetBed) &&
        isValidTimeString(target.targetWake) &&
        Number.isFinite(threshold) &&
        threshold > 0,
    );
  }

  function sanitizeTargetHistory(history) {
    const byDate = new Map();
    (Array.isArray(history) ? history : []).forEach((target) => {
      if (!target || !isValidDateString(target.effectiveFrom) || !isValidTargetConfig(target)) return;
      byDate.set(target.effectiveFrom, {
        effectiveFrom: target.effectiveFrom,
        targetBed: target.targetBed,
        targetWake: target.targetWake,
        driftThreshold: Number(target.driftThreshold),
      });
    });
    return Array.from(byDate.values()).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }

  function upsertTargetHistory(history, target, effectiveFrom) {
    if (!isValidDateString(effectiveFrom) || !isValidTargetConfig(target)) {
      return sanitizeTargetHistory(history);
    }
    return sanitizeTargetHistory([
      ...(Array.isArray(history) ? history : []),
      {
        effectiveFrom,
        targetBed: target.targetBed,
        targetWake: target.targetWake,
        driftThreshold: Number(target.driftThreshold),
      },
    ]);
  }

  function resolveTargetForDate(entry, settings) {
    if (entry && isValidTargetConfig(entry.targetSnapshot)) {
      return {
        targetBed: entry.targetSnapshot.targetBed,
        targetWake: entry.targetSnapshot.targetWake,
        driftThreshold: Number(entry.targetSnapshot.driftThreshold),
        effectiveFrom: isValidDateString(entry.targetSnapshot.effectiveFrom)
          ? entry.targetSnapshot.effectiveFrom
          : entry.date,
        source: "snapshot",
      };
    }

    const history = sanitizeTargetHistory(settings && settings.targetHistory);
    if (history.length) {
      const date = entry && isValidDateString(entry.date) ? entry.date : history.at(-1).effectiveFrom;
      let selected = history[0];
      history.forEach((target) => {
        if (target.effectiveFrom <= date) selected = target;
      });
      return { ...selected, source: "history" };
    }

    const fallback = isValidTargetConfig(settings)
      ? settings
      : { targetBed: "23:00", targetWake: "07:00", driftThreshold: 30 };
    return {
      targetBed: fallback.targetBed,
      targetWake: fallback.targetWake,
      driftThreshold: Number(fallback.driftThreshold),
      effectiveFrom: "",
      source: "current",
    };
  }

  function analyzeEntries(entries, settings) {
    const items = entries.map((entry) => {
      const appliedTarget = resolveTargetForDate(entry, settings);
      const threshold = appliedTarget.driftThreshold;
      const targetBed = normalizeNightTime(appliedTarget.targetBed, "bed");
      const targetWake = normalizeNightTime(appliedTarget.targetWake, "wake");
      const bedNorm = normalizeNightTime(entry.bedTime, "bed");
      const wakeNorm = normalizeNightTime(entry.wakeTime, "wake");
      const duration = wakeNorm >= bedNorm ? wakeNorm - bedNorm : wakeNorm + 24 * 60 - bedNorm;
      const targetReasons = [];

      if (bedNorm - targetBed > threshold) targetReasons.push({ type: "late-bed", minutes: bedNorm - targetBed });
      if (wakeNorm - targetWake > threshold) targetReasons.push({ type: "late-wake", minutes: wakeNorm - targetWake });
      if (duration < 6 * 60) targetReasons.push({ type: "short-sleep", minutes: duration });

      return {
        ...entry,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        bedNorm,
        wakeNorm,
        duration,
        appliedTarget,
        targetReasons,
        stable: targetReasons.length === 0,
      };
    });
    return { items };
  }

  function dateToDayNumber(date) {
    const [year, month, day] = String(date).split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  }

  function dayNumberToDate(dayNumber) {
    const date = new Date(dayNumber * DAY_MS);
    return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-");
  }

  function buildCalendarTimeline(items) {
    const normalizedItems = dedupeEntriesByDate(items);
    if (!normalizedItems.length) return [];
    const itemByDate = new Map(normalizedItems.map((item) => [item.date, item]));
    const dayNumbers = normalizedItems.map((item) => dateToDayNumber(item.date));
    const first = Math.min(...dayNumbers);
    const last = Math.max(...dayNumbers);
    const days = [];

    for (let dayNumber = first; dayNumber <= last; dayNumber += 1) {
      const date = dayNumberToDate(dayNumber);
      days.push({
        date,
        dayNumber,
        monthKey: date.slice(0, 7),
        dayOfMonth: Number(date.slice(8, 10)),
        item: itemByDate.get(date) || null,
      });
    }
    return days;
  }

  function groupTimelineByMonth(days) {
    const groups = [];
    const byKey = new Map();
    days.forEach((day) => {
      let group = byKey.get(day.monthKey);
      if (!group) {
        const [year, month] = day.monthKey.split("-").map(Number);
        group = {
          key: day.monthKey,
          year,
          month,
          label: `${year}年${month}月`,
          days: [],
          recordCount: 0,
          anomalyCount: 0,
        };
        byKey.set(day.monthKey, group);
        groups.push(group);
      }
      group.days.push(day);
      if (day.item) {
        group.recordCount += 1;
        if (day.item.targetReasons && day.item.targetReasons.length) group.anomalyCount += 1;
      }
    });
    return groups;
  }

  function sortMonthsNewestFirst(months) {
    return months.slice().sort((a, b) => b.key.localeCompare(a.key));
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function addRollingMedians(days, windowSize = 7, minSamples = 4) {
    return days.map((day, index) => {
      if (!day.item) return { ...day, bedMedian: null, wakeMedian: null };
      const samples = days
        .slice(Math.max(0, index - windowSize + 1), index + 1)
        .map((candidate) => candidate.item)
        .filter(Boolean);
      if (samples.length < minSamples) return { ...day, bedMedian: null, wakeMedian: null };
      return {
        ...day,
        bedMedian: median(samples.map((item) => item.bedNorm)),
        wakeMedian: median(samples.map((item) => item.wakeNorm)),
      };
    });
  }

  function makeSegmentedPath(points) {
    let penDown = false;
    return points
      .map((point) => {
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
          penDown = false;
          return "";
        }
        const command = penDown ? "L" : "M";
        penDown = true;
        return `${command} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  }

  function makeContinuousPath(points) {
    return makeSegmentedPath(points.filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1])));
  }

  function getChartRange(items, settings) {
    const values = items.flatMap((item) => [item.bedNorm, item.wakeNorm]);
    const targetValues = items.length
      ? items.flatMap((item) => {
          const target = item.appliedTarget || resolveTargetForDate(item, settings);
          return [normalizeNightTime(target.targetBed, "bed"), normalizeNightTime(target.targetWake, "wake")];
        })
      : [normalizeNightTime(settings.targetBed, "bed"), normalizeNightTime(settings.targetWake, "wake")];
    const rawMin = Math.min(22 * 60, ...values, ...targetValues);
    const rawMax = Math.max(33 * 60, ...values, ...targetValues);
    return {
      min: Math.floor(rawMin / 60) * 60,
      max: Math.ceil(rawMax / 60) * 60,
    };
  }

  return {
    timeToMinutes,
    isValidTimeString,
    isValidDateString,
    dedupeEntriesByDate,
    normalizeNightTime,
    sleepDuration,
    isValidTargetConfig,
    sanitizeTargetHistory,
    upsertTargetHistory,
    resolveTargetForDate,
    analyzeEntries,
    dateToDayNumber,
    dayNumberToDate,
    buildCalendarTimeline,
    groupTimelineByMonth,
    sortMonthsNewestFirst,
    median,
    addRollingMedians,
    makeSegmentedPath,
    makeContinuousPath,
    getChartRange,
  };
});
