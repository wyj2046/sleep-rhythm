const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../trend-core.js");

const settings = { targetBed: "23:00", targetWake: "07:00", driftThreshold: 30 };
const historicalSettings = {
  targetBed: "23:00",
  targetWake: "06:20",
  driftThreshold: 30,
  targetHistory: [
    { effectiveFrom: "2026-05-29", targetBed: "23:00", targetWake: "06:50", driftThreshold: 30 },
    { effectiveFrom: "2026-07-11", targetBed: "23:00", targetWake: "06:30", driftThreshold: 30 },
    { effectiveFrom: "2026-08-31", targetBed: "23:00", targetWake: "06:20", driftThreshold: 30 },
  ],
};

function entry(id, date, bedTime, wakeTime = "07:00") {
  return { id, date, bedTime, wakeTime, tags: [], note: "" };
}

test("normalizes overnight times and calculates duration", () => {
  assert.equal(core.sleepDuration("23:00", "06:50"), 470);
  assert.equal(core.sleepDuration("03:00", "07:45"), 285);
  assert.equal(core.median([core.normalizeNightTime("23:50", "bed"), core.normalizeNightTime("00:10", "bed"), core.normalizeNightTime("23:40", "bed")]), 1430);
});

test("rejects impossible dates and times and keeps the newest entry per date", () => {
  assert.equal(core.isValidDateString("2026-02-29"), false);
  assert.equal(core.isValidDateString("2028-02-29"), true);
  assert.equal(core.isValidTimeString("23:59"), true);
  assert.equal(core.isValidTimeString("24:00"), false);

  const older = { ...entry("old", "2026-06-01", "23:00"), updatedAt: "2026-06-01T10:00:00.000Z" };
  const newer = { ...entry("new", "2026-06-01", "23:20"), updatedAt: "2026-06-02T10:00:00.000Z" };
  const normalized = core.dedupeEntriesByDate([newer, older, entry("invalid", "2026-99-99", "23:00")]);
  assert.deepEqual(normalized.map((item) => item.id), ["new"]);
});

test("groups every valid observation by calendar month", () => {
  const analyzed = core.analyzeEntries(
    [entry("c", "2026-07-01", "23:00"), entry("a", "2026-05-31", "23:00"), entry("b", "2026-06-01", "23:00")],
    settings,
  );
  const days = core.buildCalendarTimeline(analyzed.items);
  const months = core.groupTimelineByMonth(days);
  assert.deepEqual(months.map((month) => month.key), ["2026-05", "2026-06", "2026-07"]);
  assert.deepEqual(core.sortMonthsNewestFirst(months).map((month) => month.key), ["2026-07", "2026-06", "2026-05"]);
  assert.equal(months.reduce((sum, month) => sum + month.recordCount, 0), analyzed.items.length);
  assert.deepEqual(
    months.flatMap((month) => month.days.map((day) => day.item && day.item.id).filter(Boolean)).sort(),
    ["a", "b", "c"],
  );
});

test("keeps missing calendar days while allowing the rendered line to bridge gaps", () => {
  const analyzed = core.analyzeEntries(
    [entry("a", "2026-06-22", "23:00"), entry("b", "2026-06-24", "23:10")],
    settings,
  );
  const days = core.buildCalendarTimeline(analyzed.items);
  assert.deepEqual(days.map((day) => day.date), ["2026-06-22", "2026-06-23", "2026-06-24"]);
  assert.equal(days[1].item, null);
  assert.equal(core.makeSegmentedPath([[0, 1], null, [2, 3]]), "M 0.0 1.0 M 2.0 3.0");
  assert.equal(core.makeContinuousPath([[0, 1], null, [2, 3]]), "M 0.0 1.0 L 2.0 3.0");
});

test("computes seven-calendar-day medians across month boundaries", () => {
  const raw = [
    entry("1", "2026-05-29", "23:00"),
    entry("2", "2026-05-30", "23:10"),
    entry("3", "2026-05-31", "23:20"),
    entry("4", "2026-06-01", "23:30"),
    entry("5", "2026-06-02", "23:40"),
    entry("6", "2026-06-04", "00:00"),
    entry("7", "2026-06-05", "00:10"),
    entry("8", "2026-06-06", "00:20"),
  ];
  const analyzed = core.analyzeEntries(raw, settings);
  const days = core.addRollingMedians(core.buildCalendarTimeline(analyzed.items));
  assert.equal(days.find((day) => day.date === "2026-06-05").bedMedian, 1415);
  assert.equal(days.find((day) => day.date === "2026-06-06").bedMedian, 1430);
  assert.equal(days.find((day) => day.date === "2026-06-03").bedMedian, null);
});

test("preserves existing anomaly thresholds at exact boundaries", () => {
  const analyzed = core.analyzeEntries(
    [
      entry("exact", "2026-06-01", "23:30", "07:00"),
      entry("late", "2026-06-02", "23:31", "07:00"),
      entry("short", "2026-06-03", "01:01", "07:00"),
      entry("six", "2026-06-04", "01:00", "07:00"),
    ],
    settings,
  );
  const byId = new Map(analyzed.items.map((item) => [item.id, item]));
  assert.equal(byId.get("exact").stable, true);
  assert.equal(byId.get("late").targetReasons[0].type, "late-bed");
  assert.equal(byId.get("short").targetReasons.some((reason) => reason.type === "short-sleep"), true);
  assert.equal(byId.get("six").targetReasons.some((reason) => reason.type === "short-sleep"), false);
});

test("uses the target that was effective on each record date", () => {
  const analyzed = core.analyzeEntries(
    [
      entry("before-first", "2026-05-01", "23:00", "07:20"),
      entry("old-stable", "2026-07-10", "23:00", "07:20"),
      entry("middle-late", "2026-07-11", "23:00", "07:20"),
      entry("boundary", "2026-08-31", "23:00", "06:50"),
      entry("new-late", "2026-09-01", "23:00", "06:51"),
    ],
    historicalSettings,
  );
  const byId = new Map(analyzed.items.map((item) => [item.id, item]));

  assert.equal(byId.get("before-first").appliedTarget.targetWake, "06:50");
  assert.equal(byId.get("old-stable").stable, true);
  assert.equal(byId.get("middle-late").targetReasons[0].minutes, 50);
  assert.equal(byId.get("boundary").stable, true);
  assert.equal(byId.get("new-late").targetReasons[0].minutes, 31);
});

test("lets a saved target snapshot take precedence over later setting changes", () => {
  const analyzed = core.analyzeEntries(
    [
      {
        ...entry("snapshot", "2026-09-01", "23:20", "07:10"),
        targetSnapshot: {
          effectiveFrom: "2026-07-11",
          targetBed: "23:00",
          targetWake: "06:50",
          driftThreshold: 30,
        },
      },
    ],
    historicalSettings,
  );
  const item = analyzed.items[0];
  assert.equal(item.appliedTarget.source, "snapshot");
  assert.equal(item.appliedTarget.targetWake, "06:50");
  assert.equal(item.stable, true);
});

test("normalizes target history and replaces repeated changes on the same day", () => {
  const dirtyHistory = [
    { effectiveFrom: "2026-08-31", targetBed: "23:00", targetWake: "06:30", driftThreshold: 30 },
    { effectiveFrom: "not-a-date", targetBed: "23:00", targetWake: "05:00", driftThreshold: 30 },
    { effectiveFrom: "2026-07-11", targetBed: "23:00", targetWake: "06:30", driftThreshold: 30 },
    { effectiveFrom: "2026-08-31", targetBed: "23:00", targetWake: "06:25", driftThreshold: 30 },
  ];
  const updated = core.upsertTargetHistory(
    dirtyHistory,
    { targetBed: "23:00", targetWake: "06:20", driftThreshold: 45 },
    "2026-08-31",
  );

  assert.deepEqual(updated.map((target) => target.effectiveFrom), ["2026-07-11", "2026-08-31"]);
  assert.equal(updated.at(-1).targetWake, "06:20");
  assert.equal(updated.at(-1).driftThreshold, 45);
});

test("summarizes calendar windows anchored to the latest record, with recent rule counts", () => {
  const firstDay = core.dateToDayNumber("2026-08-25");
  const raw = Array.from({ length: 40 }, (_, index) => entry(
    String(index),
    core.dayNumberToDate(firstDay + index),
    index === 0 || index === 38 ? "00:00" : "23:00",
    "06:20",
  ));
  const { items } = core.analyzeEntries(raw, historicalSettings);
  const recent = core.getRecentSummary(items, { asOfDate: "2026-10-04" });
  assert.equal(recent.startDate, "2026-09-06");
  assert.equal(recent.endDate, "2026-10-03");
  assert.equal(recent.expectedDays, 28);
  assert.equal(recent.count, 28);
  assert.equal(recent.withinRuleCount, 27);
  assert.equal(recent.anomalyCount, 1);
  assert.equal(recent.averageDuration, (27 * 440 + 380) / 28);
  assert.equal(recent.averageWake, 1820);
  assert.equal(recent.lastAnomaly.date, "2026-10-02");
  assert.equal(recent.consecutiveWithinRules, 1);
  assert.equal(recent.unrecordedSinceLatest, 0);
  assert.equal(recent.todayRecorded, false);
  const week = core.getRecentSummary(items, { asOfDate: "2026-10-04", windowDays: 7 });
  assert.equal(week.startDate, "2026-09-27");
  assert.equal(week.count, 7);
  assert.equal(week.withinRuleCount, 6);
});

test("reports missing dates without counting them as observations or crossing them in a streak", () => {
  const { items } = core.analyzeEntries([
    entry("1", "2026-09-28", "23:00"),
    entry("2", "2026-09-30", "23:00"),
    entry("3", "2026-10-01", "23:00"),
  ], settings);
  const summary = core.getRecentSummary(items, { asOfDate: "2026-10-04" });
  assert.equal(summary.startDate, "2026-09-28");
  assert.equal(summary.endDate, "2026-10-01");
  assert.equal(summary.expectedDays, 4);
  assert.equal(summary.count, 3);
  assert.equal(summary.withinRuleCount, 3);
  assert.equal(summary.consecutiveWithinRules, 2);
  assert.deepEqual(summary.missingDatesInWindow, ["2026-09-29"]);
  assert.equal(summary.unrecordedSinceLatest, 2);
  assert.deepEqual(summary.unrecordedDatesSinceLatest, ["2026-10-02", "2026-10-03"]);
  assert.equal(summary.unrecordedDatesTruncated, false);
  assert.equal(summary.lastAnomaly, null);
});

test("averages normalized overnight times rather than raw clock minutes", () => {
  const { items } = core.analyzeEntries([
    entry("1", "2026-09-30", "17:00", "23:50"),
    entry("2", "2026-10-01", "17:00", "00:10"),
  ], { targetBed: "17:00", targetWake: "00:00", driftThreshold: 30 });
  const summary = core.getRecentSummary(items, { asOfDate: "2026-10-02" });
  assert.equal(summary.averageWake, 1440);
  assert.equal(summary.averageDuration, 420);
  assert.equal(summary.withinRuleCount, 2);
  assert.equal(summary.expectedDays, 2);
});

test("keeps historical and snapshot targets in recent counts", () => {
  const { items } = core.analyzeEntries([
    entry("old", "2026-07-10", "23:00", "07:10"),
    entry("changed", "2026-07-11", "23:00", "07:10"),
    {
      ...entry("snapshot", "2026-07-12", "23:00", "07:10"),
      targetSnapshot: { targetBed: "23:00", targetWake: "06:50", driftThreshold: 30 },
    },
  ], historicalSettings);
  const summary = core.getRecentSummary(items, { asOfDate: "2026-07-13", windowDays: 3 });
  assert.equal(summary.withinRuleCount, 2);
  assert.equal(summary.anomalyCount, 1);
  assert.equal(summary.lastAnomaly.id, "changed");
  assert.equal(summary.consecutiveWithinRules, 1);
});

test("ignores future and invalid records and deduplicates before computing statistics", () => {
  const { items } = core.analyzeEntries([
    { ...entry("newer", "2026-10-03", "23:00"), updatedAt: "2026-10-04T00:00:00Z" },
    { ...entry("older", "2026-10-03", "00:00"), updatedAt: "2026-10-03T00:00:00Z" },
    entry("future", "2026-10-05", "01:00"),
    entry("today", "2026-10-04", "23:00"),
    entry("invalid-date", "2026-09-31", "23:00"),
    entry("invalid-time", "2026-10-02", "25:00"),
  ], settings);
  const before = structuredClone(items);
  const summary = core.getRecentSummary(items, { asOfDate: "2026-10-04" });
  assert.equal(summary.latestDate, "2026-10-04");
  assert.equal(summary.count, 2);
  assert.equal(summary.withinRuleCount, 2);
  assert.equal(summary.anomalyCount, 0);
  assert.equal(summary.todayRecorded, true);
  assert.equal(summary.unrecordedSinceLatest, 0);
  assert.equal(summary.lastAnomaly, null);
  assert.deepEqual(items, before);
});

test("keeps consecutive days and the latest anomaly independent of the selected window", () => {
  const firstDay = core.dateToDayNumber("2026-09-01");
  const { items } = core.analyzeEntries(Array.from({ length: 30 }, (_, index) => entry(
    String(index), core.dayNumberToDate(firstDay + index), index === 0 ? "00:00" : "23:00",
  )), settings);
  const summary = core.getRecentSummary(items, { asOfDate: "2026-10-01", windowDays: 7 });
  assert.equal(summary.count, 7);
  assert.equal(summary.anomalyCount, 0);
  assert.equal(summary.consecutiveWithinRules, 29);
  assert.equal(summary.lastAnomaly.date, "2026-09-01");
});

test("bounds expanded missing dates for old records while preserving the total", () => {
  const { items } = core.analyzeEntries([entry("old", "2020-01-01", "23:00")], settings);
  const summary = core.getRecentSummary(items, { asOfDate: "2026-10-04" });
  assert.equal(summary.unrecordedSinceLatest, core.dateToDayNumber("2026-10-04") - core.dateToDayNumber("2020-01-01") - 1);
  assert.equal(summary.unrecordedDatesSinceLatest.length, 31);
  assert.equal(summary.unrecordedDatesSinceLatest[0], "2026-09-03");
  assert.equal(summary.unrecordedDatesSinceLatest.at(-1), "2026-10-03");
  assert.equal(summary.unrecordedDatesTruncated, true);
});

test("returns explicit empty summary values when there are no available observations", () => {
  const empty = core.getRecentSummary([], { asOfDate: "2026-10-04" });
  assert.equal(empty.count, 0);
  assert.equal(empty.expectedDays, 0);
  assert.equal(empty.latestDate, null);
  assert.equal(empty.startDate, null);
  assert.equal(empty.endDate, null);
  assert.equal(empty.averageDuration, null);
  assert.equal(empty.averageWake, null);
  assert.equal(empty.consecutiveWithinRules, 0);
  assert.equal(empty.unrecordedSinceLatest, 0);
  assert.equal(empty.todayRecorded, false);
  assert.equal(empty.lastAnomaly, null);
  assert.deepEqual(empty.missingDatesInWindow, []);
  const futureItems = core.analyzeEntries([entry("future", "2026-10-05", "23:00")], settings).items;
  assert.deepEqual(core.getRecentSummary(futureItems, { asOfDate: "2026-10-04" }), empty);
  assert.equal(core.getRecentSummary().asOfDate, null);
});
