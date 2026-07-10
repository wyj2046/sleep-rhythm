const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../trend-core.js");

const settings = { targetBed: "23:00", targetWake: "07:00", driftThreshold: 30 };

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
  assert.equal(months.reduce((sum, month) => sum + month.recordCount, 0), analyzed.items.length);
  assert.deepEqual(
    months.flatMap((month) => month.days.map((day) => day.item && day.item.id).filter(Boolean)).sort(),
    ["a", "b", "c"],
  );
});

test("keeps missing calendar days and breaks paths at gaps", () => {
  const analyzed = core.analyzeEntries(
    [entry("a", "2026-06-22", "23:00"), entry("b", "2026-06-24", "23:10")],
    settings,
  );
  const days = core.buildCalendarTimeline(analyzed.items);
  assert.deepEqual(days.map((day) => day.date), ["2026-06-22", "2026-06-23", "2026-06-24"]);
  assert.equal(days[1].item, null);
  assert.equal(core.makeSegmentedPath([[0, 1], null, [2, 3]]), "M 0.0 1.0 M 2.0 3.0");
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
