(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SleepEntryDetails = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const kinds = ["bed", "asleep", "unspecified"];
  const feelings = { rested: "精神不错", neutral: "一般", tired: "仍然疲惫" };
  const validTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const night = (value, cutoff) => minutes(value) + (minutes(value) < cutoff ? 1440 : 0);

  function normalize(entry = {}) {
    const result = {};
    // Absent means legacy/unknown. Never infer the meaning of old timestamps.
    if (kinds.includes(entry.bedTimeKind)) result.bedTimeKind = entry.bedTimeKind;
    for (const key of ["sleepOnsetTime", "finalWakeTime"]) {
      if (validTime(entry[key])) result[key] = entry[key];
    }
    if (entry.awakeMinutes !== "" && entry.awakeMinutes != null) {
      const value = Number(entry.awakeMinutes);
      if (Number.isInteger(value) && value >= 0 && value <= 1440) result.awakeMinutes = value;
    }
    if (Object.hasOwn(feelings, entry.morningFeeling)) result.morningFeeling = entry.morningFeeling;
    return result;
  }

  function validate(entry) {
    if (!validTime(entry.bedTime) || !validTime(entry.wakeTime)) return { field: "bedTime", message: "请填写有效的就寝与起床时间。" };
    const bed = night(entry.bedTime, 720);
    let end = night(entry.wakeTime, 1080);
    if (end < bed) end += 1440;
    if (end === bed || end - bed > 1440) return { field: "wakeTime", message: "请确认时间：起床应在就寝之后，记录时段不超过 24 小时。" };
    let onset = bed;
    let finalWake = end;
    if (entry.sleepOnsetTime) {
      if (!validTime(entry.sleepOnsetTime)) return { field: "sleepOnsetTime", message: "请填写有效的估计睡着时间。" };
      onset = minutes(entry.sleepOnsetTime);
      while (onset < bed) onset += 1440;
      if (onset < bed || onset > end) return { field: "sleepOnsetTime", message: "估计睡着时间应在就寝与起床之间；跨过午夜可直接填写凌晨时间。" };
      if (entry.bedTimeKind === "asleep" && entry.sleepOnsetTime !== entry.bedTime) return { field: "sleepOnsetTime", message: "就寝时间已标为估计睡着，请将两个时间保持一致，或将就寝含义改为上床。" };
    }
    if (entry.finalWakeTime) {
      if (!validTime(entry.finalWakeTime)) return { field: "finalWakeTime", message: "请填写有效的最终醒来时间。" };
      finalWake = night(entry.finalWakeTime, 1080);
      if (finalWake < bed) finalWake += 1440;
      if (finalWake < onset || finalWake > end) return { field: "finalWakeTime", message: "最终醒来应在睡着之后、离床之前。" };
    }
    if (entry.awakeMinutes !== "" && entry.awakeMinutes != null) {
      const awake = Number(entry.awakeMinutes);
      if (!Number.isInteger(awake) || awake < 0 || awake > finalWake - onset) return { field: "awakeMinutes", message: "夜间清醒分钟数应为非负整数，且不超过记录的夜间时段。" };
    }
    return null;
  }

  function bedtimeLabel(entry) {
    return entry.bedTimeKind === "bed" ? "上床" : entry.bedTimeKind === "asleep" ? "估计睡着" : "就寝（原入睡）";
  }

  return { normalize, validate, bedtimeLabel, feelings };
});
