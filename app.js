(function () {
  const STORAGE_KEY = "sleep-rhythm.entries.v1";
  const SETTINGS_KEY = "sleep-rhythm.settings.v1";
  const CHART_PREFS_KEY = "sleep-rhythm.chart-prefs.v1";
  const CLOUD_QUEUE_KEY = "sleep-rhythm.cloud-queue.v1";
  const FIREBASE_SDK_VERSION = "12.13.0";
  const TARGET_HISTORY_VERSION = 1;
  const WAKE_620_EFFECTIVE_FROM = "2026-08-31";
  const tags = ["工作", "娱乐", "运动", "社交", "补觉", "折腾", "去医院", "生病", "失眠"];
  const legacyDefaultSettings = {
    targetBed: "23:30",
    targetWake: "07:30",
    driftThreshold: 45,
  };
  const defaultSettings = {
    targetBed: "23:00",
    targetWake: "06:20",
    driftThreshold: 30,
  };
  const knownTargetHistory = [
    { effectiveFrom: "2026-05-29", targetBed: "23:00", targetWake: "06:50", driftThreshold: 30 },
    { effectiveFrom: "2026-07-11", targetBed: "23:00", targetWake: "06:30", driftThreshold: 30 },
    { effectiveFrom: WAKE_620_EFFECTIVE_FROM, ...defaultSettings },
  ];
  const trendCore = window.SleepTrendCore;

  if (!trendCore) {
    throw new Error("SleepTrendCore failed to load.");
  }

  let pendingLocalSnapshotHistory = null;
  const state = {
    entries: loadEntries(),
    settings: loadSettings(),
  };
  if (pendingLocalSnapshotHistory) {
    const localSnapshotBackfill = backfillTargetSnapshots(state.entries, pendingLocalSnapshotHistory);
    state.entries = localSnapshotBackfill.entries;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    if (localSnapshotBackfill.upserts.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    }
  }
  const syncState = {
    configured: false,
    ready: false,
    loading: false,
    user: null,
    auth: null,
    db: null,
    provider: null,
    firebase: null,
    pendingTimer: 0,
    googleReady: false,
    lastSyncAt: "",
    flushPromise: null,
  };
  const trendUi = {
    selectedDate: null,
    showMedian: loadChartPreferences().showMedian !== false,
  };
  const cloudQueue = loadCloudQueue();

  const $ = (selector) => document.querySelector(selector);
  const els = {
    form: $("#entryForm"),
    settingsForm: $("#settingsForm"),
    editingId: $("#editingId"),
    sleepDate: $("#sleepDate"),
    bedTime: $("#bedTime"),
    wakeTime: $("#wakeTime"),
    note: $("#note"),
    tagGrid: $("#tagGrid"),
    targetBed: $("#targetBed"),
    targetWake: $("#targetWake"),
    driftThreshold: $("#driftThreshold"),
    driftValue: $("#driftValue"),
    targetEffectiveStatus: $("#targetEffectiveStatus"),
    targetHistoryList: $("#targetHistoryList"),
    statsGrid: $("#statsGrid"),
    chart: $("#trendChart"),
    rangeLabel: $("#rangeLabel"),
    trendTitle: $("#trendTitle"),
    trendDescription: $("#trendDescription"),
    trendSourceStatus: $("#trendSourceStatus"),
    medianToggle: $("#medianToggle"),
    monthJump: $("#monthJump"),
    monthCharts: $("#monthCharts"),
    dayDetail: $("#dayDetail"),
    anomalyList: $("#anomalyList"),
    entryList: $("#entryList"),
    resetFormBtn: $("#resetFormBtn"),
    clearAllBtn: $("#clearAllBtn"),
    exportCsvBtn: $("#exportCsvBtn"),
    exportJsonBtn: $("#exportJsonBtn"),
    importJsonInput: $("#importJsonInput"),
    cloudBadge: $("#cloudBadge"),
    cloudStatus: $("#cloudStatus"),
    signInBtn: $("#signInBtn"),
    signOutBtn: $("#signOutBtn"),
    syncNowBtn: $("#syncNowBtn"),
    googleButtonHost: $("#googleButtonHost"),
  };

  init();

  function init() {
    ensureCloudElements();
    renderTags();
    hydrateForms();
    updateTrendSourceStatus("local");
    els.medianToggle.checked = trendUi.showMedian;
    bindEvents();
    render();
    initCloudSync();
    if (window.lucide) {
      window.lucide.createIcons();
    } else {
      window.addEventListener("load", () => window.lucide && window.lucide.createIcons());
    }
  }

  function bindEvents() {
    els.form.addEventListener("submit", saveEntry);
    els.resetFormBtn.addEventListener("click", resetEntryForm);
    els.settingsForm.addEventListener("submit", saveSettings);
    els.driftThreshold.addEventListener("input", () => {
      els.driftValue.textContent = `${Number(els.driftThreshold.value) || defaultSettings.driftThreshold} 分钟`;
    });
    els.clearAllBtn.addEventListener("click", clearAll);
    els.exportCsvBtn.addEventListener("click", exportCsv);
    els.exportJsonBtn.addEventListener("click", exportJson);
    els.importJsonInput.addEventListener("change", importJson);
    els.signInBtn.addEventListener("click", signInWithGoogle);
    els.signOutBtn.addEventListener("click", signOutCloud);
    els.syncNowBtn.addEventListener("click", refreshCloudData);
    els.medianToggle.addEventListener("change", toggleMedian);
    els.monthJump.addEventListener("click", handleMonthJump);
    els.monthCharts.addEventListener("click", handleTrendClick);
    els.monthCharts.addEventListener("keydown", handleTrendKeydown);
    els.dayDetail.addEventListener("click", handleDetailAction);
    window.addEventListener("resize", debounce(() => renderChart(), 120));
    document.addEventListener("keydown", (event) => {
      const inTrendWorkspace = event.target && event.target.closest && event.target.closest("#trendWorkspace");
      if (event.key === "Escape" && trendUi.selectedDate && inTrendWorkspace) clearTrendSelection();
    });
  }

  function ensureCloudElements() {
    if (!els.googleButtonHost && els.signInBtn) {
      els.googleButtonHost = document.createElement("div");
      els.googleButtonHost.className = "google-button-host";
      els.googleButtonHost.id = "googleButtonHost";
      els.googleButtonHost.hidden = true;
      els.signInBtn.before(els.googleButtonHost);
    }
  }

  function renderTags(selected = []) {
    els.tagGrid.innerHTML = tags
      .map(
        (tag) => `
          <label class="tag-chip">
            <input type="checkbox" name="tags" value="${escapeHtml(tag)}" ${selected.includes(tag) ? "checked" : ""}>
            <span>${escapeHtml(tag)}</span>
          </label>
        `,
      )
      .join("");
  }

  function hydrateForms() {
    els.sleepDate.value = todayString();
    els.bedTime.value = state.settings.targetBed;
    els.wakeTime.value = state.settings.targetWake;
    els.targetBed.value = state.settings.targetBed;
    els.targetWake.value = state.settings.targetWake;
    els.driftThreshold.value = state.settings.driftThreshold;
    els.driftValue.textContent = `${state.settings.driftThreshold} 分钟`;
    renderTargetHistory();
  }

  function renderTargetHistory() {
    if (!els.targetEffectiveStatus || !els.targetHistoryList) return;
    const activeTarget = trendCore.resolveTargetForDate({ date: todayString() }, state.settings);
    els.targetEffectiveStatus.textContent = `${formatHistoryDate(activeTarget.effectiveFrom)}起生效；只影响该日及以后，之前按当时目标计算。`;
    els.targetHistoryList.innerHTML = state.settings.targetHistory
      .slice()
      .reverse()
      .map(
        (target) => `
          <div class="target-history-item">
            <time datetime="${target.effectiveFrom}">${formatHistoryDate(target.effectiveFrom)}</time>
            <strong>${target.targetBed} → ${target.targetWake}</strong>
            <span>±${target.driftThreshold} 分钟</span>
          </div>
        `,
      )
      .join("");
  }

  function saveEntry(event) {
    event.preventDefault();
    const date = els.sleepDate.value;
    const requestedId = els.editingId.value || makeId();
    const currentIndex = state.entries.findIndex((item) => item.id === requestedId);
    const currentEntry = currentIndex >= 0 ? state.entries[currentIndex] : null;
    const sameDateEntry = state.entries.find((item) => item.date === date);
    const snapshotSource = currentEntry && currentEntry.date === date ? currentEntry : sameDateEntry;
    const entry = {
      id: requestedId,
      date,
      bedTime: els.bedTime.value,
      wakeTime: els.wakeTime.value,
      tags: Array.from(document.querySelectorAll('input[name="tags"]:checked')).map((input) => input.value),
      note: els.note.value.trim(),
      targetSnapshot: makeTargetSnapshot(date, snapshotSource && snapshotSource.targetSnapshot),
      updatedAt: new Date().toISOString(),
    };

    let savedEntry = entry;
    const replacedIds = [];
    if (currentIndex >= 0) {
      const collidingEntry = state.entries.find((item) => item.id !== entry.id && item.date === entry.date);
      if (collidingEntry) replacedIds.push(collidingEntry.id);
      state.entries[currentIndex] = entry;
      state.entries = state.entries.filter((item) => item.id === entry.id || item.date !== entry.date);
      savedEntry = entry;
    } else {
      const sameDateIndex = state.entries.findIndex((item) => item.date === entry.date);
      if (sameDateIndex >= 0) {
        state.entries[sameDateIndex] = { ...entry, id: state.entries[sameDateIndex].id };
        savedEntry = state.entries[sameDateIndex];
      } else {
        state.entries.push(entry);
        savedEntry = entry;
      }
    }

    sortEntries();
    persistEntries();
    replacedIds.forEach(queueCloudDelete);
    queueCloudUpsert(savedEntry);
    resetEntryForm();
    render();
  }

  function saveSettings(event) {
    event.preventDefault();
    const previousTargetBed = state.settings.targetBed;
    const previousTargetWake = state.settings.targetWake;
    const nextTarget = {
      targetBed: els.targetBed.value || defaultSettings.targetBed,
      targetWake: els.targetWake.value || defaultSettings.targetWake,
      driftThreshold: Number(els.driftThreshold.value) || defaultSettings.driftThreshold,
    };
    state.settings = sanitizeSettings(
      {
        ...nextTarget,
        targetHistoryVersion: TARGET_HISTORY_VERSION,
        targetHistory: trendCore.upsertTargetHistory(state.settings.targetHistory, nextTarget, todayString()),
      },
      { migrateKnownHistory: false },
    );
    if (!els.editingId.value && (!els.bedTime.value || els.bedTime.value === previousTargetBed)) {
      els.bedTime.value = state.settings.targetBed;
    }
    if (!els.editingId.value && (!els.wakeTime.value || els.wakeTime.value === previousTargetWake)) {
      els.wakeTime.value = state.settings.targetWake;
    }
    els.driftValue.textContent = `${state.settings.driftThreshold} 分钟`;
    renderTargetHistory();
    persistSettings();
    queueCloudSettings(state.settings);
    render();
  }

  function resetEntryForm() {
    els.editingId.value = "";
    els.sleepDate.value = todayString();
    els.bedTime.value = state.settings.targetBed;
    els.wakeTime.value = state.settings.targetWake;
    els.note.value = "";
    renderTags();
    els.form.querySelector(".primary-button").innerHTML = '<i data-lucide="save"></i>保存记录';
    window.lucide && window.lucide.createIcons();
  }

  function render() {
    sortEntries();
    const analysis = analyzeEntries();
    renderStats(analysis);
    renderChart(analysis);
    renderAnomalies(analysis);
    renderEntries(analysis);
  }

  function renderStats(analysis) {
    const latest = analysis.items.at(-1);
    const stableDays = countStableDays(analysis.items);
    const averageDuration = average(
      analysis.items.map((item) => item.duration).filter((duration) => Number.isFinite(duration)),
    );
    const recovery = latest ? recoveryLabel(analysis.items) : "暂无";

    const cards = [
      {
        label: "记录天数",
        value: String(analysis.items.length),
        hint: latest ? formatDate(latest.date) : "从今晚开始",
      },
      {
        label: "当前稳定",
        value: `${stableDays} 天`,
        hint: "目标范围内",
      },
      {
        label: "平均睡眠",
        value: averageDuration ? formatDuration(averageDuration) : "暂无",
        hint: "按已记录天数",
      },
      {
        label: "最近恢复",
        value: recovery,
        hint: "从上次明显偏离后",
      },
    ];

    els.statsGrid.innerHTML = cards
      .map(
        (card) => `
          <article class="stat-card">
            <span>${card.label}</span>
            <strong>${card.value}</strong>
            <small>${card.hint}</small>
          </article>
        `,
      )
      .join("");
  }

  function renderChart(analysis = analyzeEntries()) {
    const model = buildTrendModel(analysis);
    trendUi.model = model;
    renderTrendHeader(model);

    if (!model.items.length) {
      const width = Math.max(280, Math.round(els.chart.getBoundingClientRect().width || 720));
      els.chart.setAttribute("viewBox", `0 0 ${width} 100`);
      els.chart.innerHTML = `<text x="${width / 2}" y="54" text-anchor="middle" class="empty-state">还没有记录</text>`;
      els.monthJump.innerHTML = "";
      els.monthCharts.innerHTML = '<p class="trend-empty">保存第一晚记录后，这里会按月展示完整节律。</p>';
      els.dayDetail.innerHTML = "";
      els.dayDetail.hidden = true;
      return;
    }

    renderOverviewChart(model);
    renderMonthJump(model);
    renderMonthCharts(model);
    renderDayDetail(model);
    window.lucide && window.lucide.createIcons();
  }

  function buildTrendModel(analysis) {
    const items = trendCore.dedupeEntriesByDate(analysis.items).sort(byDateValue);
    const timeline = trendCore.addRollingMedians(trendCore.buildCalendarTimeline(items));
    const chronologicalMonths = trendCore.groupTimelineByMonth(timeline);
    const months = trendCore.sortMonthsNewestFirst(chronologicalMonths);
    const itemByDate = new Map(items.map((item) => [item.date, item]));
    const anomalies = items.filter((item) => item.targetReasons.length);
    const range = trendCore.getChartRange(items, state.settings);

    if (trendUi.selectedDate === null || (trendUi.selectedDate && !itemByDate.has(trendUi.selectedDate))) {
      trendUi.selectedDate = (anomalies.at(-1) || items.at(-1) || {}).date || "";
    }

    return {
      items,
      timeline,
      chronologicalMonths,
      months,
      itemByDate,
      anomalies,
      range,
      selectedItem: trendUi.selectedDate ? itemByDate.get(trendUi.selectedDate) || null : null,
    };
  }

  function renderTrendHeader(model) {
    if (!model.items.length) {
      els.rangeLabel.textContent = "";
      els.trendTitle.textContent = "从今晚开始记录节律";
      els.trendDescription.textContent = "还没有睡眠记录。";
      return;
    }

    const first = model.items[0];
    const latest = model.items.at(-1);
    const stableDays = countStableDays(model.items);
    const anomalyCount = model.anomalies.length;
    els.rangeLabel.textContent = `${first.date} → ${latest.date} · 共 ${model.items.length} 晚`;
    els.trendTitle.textContent =
      stableDays >= 7
        ? `过去 ${stableDays} 天节律稳定，少数夜晚形成明显断点。`
        : anomalyCount
          ? `节律仍在恢复，${anomalyCount} 个夜晚形成明显断点。`
          : "节律保持稳定，继续观察长期变化。";
    els.trendDescription.textContent = `全部日期从 ${first.date} 到 ${latest.date}，共 ${model.items.length} 晚，${anomalyCount} 晚偏离当日目标。蓝线表示入睡，红线表示起床，橙色外环表示偏离；目标背景按生效日期分段。`;
  }

  function renderOverviewChart(model) {
    const width = Math.max(280, Math.round(els.chart.getBoundingClientRect().width || 720));
    const height = window.innerWidth <= 760 ? 96 : 112;
    const margin = { top: 8, right: 10, bottom: 24, left: 38 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = (index) => margin.left + (model.timeline.length === 1 ? plotWidth / 2 : (index / (model.timeline.length - 1)) * plotWidth);
    const y = (minutes) => margin.top + ((minutes - model.range.min) / (model.range.max - model.range.min)) * plotHeight;
    const bedPath = trendCore.makeContinuousPath(model.timeline.map((day, index) => (day.item ? [x(index), y(day.item.bedNorm)] : null)));
    const wakePath = trendCore.makeContinuousPath(model.timeline.map((day, index) => (day.item ? [x(index), y(day.item.wakeNorm)] : null)));
    const bedMedian = trendCore.makeContinuousPath(
      model.timeline.map((day, index) => (trendUi.showMedian && Number.isFinite(day.bedMedian) ? [x(index), y(day.bedMedian)] : null)),
    );
    const wakeMedian = trendCore.makeContinuousPath(
      model.timeline.map((day, index) => (trendUi.showMedian && Number.isFinite(day.wakeMedian) ? [x(index), y(day.wakeMedian)] : null)),
    );
    const maxMonthLabels = Math.max(2, Math.floor(plotWidth / 76));
    const monthLabelStep = Math.max(1, Math.ceil(model.chronologicalMonths.length / maxMonthLabels));
    const spansYears = new Set(model.chronologicalMonths.map((month) => month.year)).size > 1;
    const monthLabels = model.chronologicalMonths
      .map((month, monthIndex) => {
        if (monthIndex % monthLabelStep !== 0 && monthIndex !== model.chronologicalMonths.length - 1) return "";
        const index = model.timeline.findIndex((day) => day.monthKey === month.key);
        const label = spansYears && (month.month === 1 || monthIndex === 0) ? `${month.year}年${month.month}月` : `${month.month}月`;
        return `<text class="overview-date-label" x="${x(index)}" y="${height - 6}" text-anchor="start">${label}</text>`;
      })
      .join("");
    const anomalyMarks = model.timeline
      .map((day, index) =>
        day.item && day.item.targetReasons.length
          ? `<circle class="overview-anomaly" cx="${x(index)}" cy="${y(day.item.bedNorm)}" r="3.5"></circle>`
          : "",
      )
      .join("");
    const selectedIndex = model.timeline.findIndex((day) => day.date === trendUi.selectedDate);
    const selectedMark =
      selectedIndex >= 0
        ? `<line class="overview-selection" x1="${x(selectedIndex)}" y1="${margin.top}" x2="${x(selectedIndex)}" y2="${height - margin.bottom}"></line>`
        : "";

    els.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    els.chart.innerHTML = `
      ${targetBandTimelineMarkup(model.timeline, x, y, model.range, margin.left, plotWidth)}
      <line class="overview-guide" x1="${margin.left}" y1="${y(model.range.min)}" x2="${width - margin.right}" y2="${y(model.range.min)}"></line>
      <line class="overview-guide" x1="${margin.left}" y1="${y(model.range.max)}" x2="${width - margin.right}" y2="${y(model.range.max)}"></line>
      <text class="overview-axis-label" x="${margin.left - 7}" y="${y(model.range.min) + 3}" text-anchor="end">${formatAxisTime(model.range.min)}</text>
      <text class="overview-axis-label" x="${margin.left - 7}" y="${y(model.range.max) + 3}" text-anchor="end">${formatAxisTime(model.range.max)}</text>
      <path class="overview-line sleep" d="${bedPath}"></path>
      <path class="overview-line wake" d="${wakePath}"></path>
      ${trendUi.showMedian ? `<path class="overview-median sleep" d="${bedMedian}"></path><path class="overview-median wake" d="${wakeMedian}"></path>` : ""}
      ${anomalyMarks}
      ${selectedMark}
      ${monthLabels}
    `;
  }

  function renderMonthJump(model) {
    const selectedMonth = trendUi.selectedDate ? trendUi.selectedDate.slice(0, 7) : "";
    const spansYears = new Set(model.months.map((month) => month.year)).size > 1;
    els.monthJump.innerHTML = model.months
      .map(
        (month) => `
          <button
            class="month-jump-button${month.key === selectedMonth ? " is-current" : ""}"
            type="button"
            data-month-target="${month.key}"
            aria-label="跳转到 ${month.label}"
            ${month.key === selectedMonth ? 'aria-current="true"' : ""}
          >${spansYears ? `${String(month.year).slice(-2)}年` : ""}${month.month}月</button>
        `,
      )
      .join("");
  }

  function renderMonthCharts(model) {
    els.monthCharts.innerHTML = model.months.map((month) => renderMonthSection(month, model)).join("");
  }

  function renderMonthSection(month, model) {
    const first = month.days[0].date;
    const last = month.days.at(-1).date;
    const anomalyText = month.anomalyCount ? ` · ${month.anomalyCount} 次偏离` : "";
    const frame = getMonthChartFrame();
    return `
      <section class="month-section" id="month-${month.key}" data-month-section="${month.key}">
        <header class="month-header">
          <h3 class="month-title">${month.label}</h3>
          <span class="month-meta">${shortDate(first)}–${shortDate(last)} · ${month.recordCount} 晚${anomalyText}</span>
        </header>
        <svg
          class="month-chart"
          data-month-chart="${month.key}"
          viewBox="0 0 ${frame.width} ${frame.height}"
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label="${month.label}睡眠趋势，共 ${month.recordCount} 晚"
        ><title>${month.label}睡眠趋势</title><desc>蓝线表示入睡，红线表示起床，橙色外环表示偏离。可用方向键浏览记录。</desc>${renderMonthSvg(month, model, frame)}</svg>
      </section>
    `;
  }

  function getMonthChartFrame() {
    const mobile = window.innerWidth <= 760;
    return {
      mobile,
      width: mobile ? 360 : 820,
      height: mobile ? 186 : 226,
      margin: mobile
        ? { top: 14, right: 10, bottom: 28, left: 42 }
        : { top: 14, right: 16, bottom: 32, left: 52 },
    };
  }

  function renderMonthSvg(month, model, frame = getMonthChartFrame()) {
    const { mobile, width, height, margin } = frame;
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = (index) => margin.left + (month.days.length === 1 ? plotWidth / 2 : (index / (month.days.length - 1)) * plotWidth);
    const y = (minutes) => margin.top + ((minutes - model.range.min) / (model.range.max - model.range.min)) * plotHeight;
    const tickStep = mobile ? 180 : 120;
    const yTicks = makeTimeTicks(model.range.min, model.range.max, tickStep);
    const grid = yTicks
      .map(
        (tick) => `
          <line class="month-grid-line" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}"></line>
          <text class="month-axis-label" x="${margin.left - 8}" y="${y(tick) + 3}" text-anchor="end">${formatAxisTime(tick)}</text>
        `,
      )
      .join("");
    const tickIndexes = month.days.length <= 7
      ? month.days.map((_, index) => index)
      : month.days.map((day, index) => ({ day, index })).filter(({ day, index }) => index === 0 || index === month.days.length - 1 || day.dayOfMonth % 5 === 0).map(({ index }) => index);
    const dateLabels = tickIndexes
      .map((index) => `<text class="month-date-label" x="${x(index)}" y="${height - 7}" text-anchor="middle">${month.days[index].dayOfMonth}</text>`)
      .join("");
    const sleepPath = trendCore.makeContinuousPath(month.days.map((day, index) => (day.item ? [x(index), y(day.item.bedNorm)] : null)));
    const wakePath = trendCore.makeContinuousPath(month.days.map((day, index) => (day.item ? [x(index), y(day.item.wakeNorm)] : null)));
    const bedMedian = trendCore.makeContinuousPath(month.days.map((day, index) => (trendUi.showMedian && Number.isFinite(day.bedMedian) ? [x(index), y(day.bedMedian)] : null)));
    const wakeMedian = trendCore.makeContinuousPath(month.days.map((day, index) => (trendUi.showMedian && Number.isFinite(day.wakeMedian) ? [x(index), y(day.wakeMedian)] : null)));
    const selectedIndex = month.days.findIndex((day) => day.date === trendUi.selectedDate);
    const selected =
      selectedIndex >= 0
        ? `<rect class="month-selection" x="${x(selectedIndex) - 9}" y="${margin.top}" width="18" height="${plotHeight}" rx="9"></rect>`
        : "";
    const missing = month.days
      .map((day, index) => (!day.item ? `<line class="missing-day" x1="${x(index)}" y1="${height - margin.bottom + 4}" x2="${x(index)}" y2="${height - margin.bottom + 10}"></line>` : ""))
      .join("");
    const points = month.days
      .map((day, index) => {
        if (!day.item) return "";
        const item = day.item;
        const isAlert = item.targetReasons.length > 0;
        const isSelected = item.date === trendUi.selectedDate;
        return `
          <g
            class="chart-day${isAlert ? " is-alert" : ""}${isSelected ? " is-selected" : ""}"
            data-date="${item.date}"
            role="button"
            tabindex="${isAlert || isSelected ? "0" : "-1"}"
            aria-label="${escapeHtml(trendDayAriaLabel(item))}"
          >
            ${isAlert ? `<circle class="anomaly-ring" cx="${x(index)}" cy="${y(item.bedNorm)}" r="7"></circle>` : ""}
            <circle class="month-point sleep" cx="${x(index)}" cy="${y(item.bedNorm)}" r="3.7"></circle>
            <circle class="month-point wake" cx="${x(index)}" cy="${y(item.wakeNorm)}" r="3.7"></circle>
          </g>
        `;
      })
      .join("");

    return `
      ${targetBandTimelineMarkup(month.days, x, y, model.range, margin.left, plotWidth)}
      <rect
        class="month-hit"
        data-month="${month.key}"
        x="${margin.left}"
        y="${margin.top}"
        width="${plotWidth}"
        height="${plotHeight}"
        tabindex="0"
        role="button"
        aria-label="${month.label}趋势图。使用左右方向键浏览记录，按回车查看详情。"
      ></rect>
      ${grid}
      ${selected}
      <path class="month-line sleep" d="${sleepPath}"></path>
      <path class="month-line wake" d="${wakePath}"></path>
      ${trendUi.showMedian ? `<path class="month-median sleep" d="${bedMedian}"></path><path class="month-median wake" d="${wakeMedian}"></path>` : ""}
      ${missing}
      ${points}
      ${dateLabels}
    `;
  }

  function targetBandTimelineMarkup(days, x, y, range, left, width) {
    if (!days.length) return "";
    const targets = days.map((day) =>
      day.item && day.item.appliedTarget
        ? day.item.appliedTarget
        : trendCore.resolveTargetForDate({ date: day.date }, state.settings),
    );
    const segments = [];
    targets.forEach((target, index) => {
      const key = [target.targetBed, target.targetWake, target.driftThreshold].join("|");
      const previous = segments.at(-1);
      if (previous && previous.key === key) {
        previous.end = index;
      } else {
        segments.push({ key, start: index, end: index, target });
      }
    });

    const step = days.length > 1 ? Math.abs(x(1) - x(0)) : width;
    const band = (targetValue, threshold, className, segmentLeft, segmentWidth) => {
      const target = trendCore.normalizeNightTime(targetValue, className === "bed" ? "bed" : "wake");
      const start = clamp(target - threshold, range.min, range.max);
      const end = clamp(target + threshold, range.min, range.max);
      return `<rect class="target-band ${className}" x="${segmentLeft.toFixed(2)}" y="${y(start).toFixed(2)}" width="${segmentWidth.toFixed(2)}" height="${Math.max(2, y(end) - y(start)).toFixed(2)}"></rect>`;
    };

    return segments
      .map((segment, index) => {
        const segmentLeft = segment.start === 0 ? left : Math.max(left, x(segment.start) - step / 2);
        const segmentRight = segment.end === days.length - 1 ? left + width : Math.min(left + width, x(segment.end) + step / 2);
        const segmentWidth = Math.max(1, segmentRight - segmentLeft);
        const changeLine = index
          ? `<line class="target-change" x1="${segmentLeft.toFixed(2)}" y1="${y(range.min).toFixed(2)}" x2="${segmentLeft.toFixed(2)}" y2="${y(range.max).toFixed(2)}"></line>`
          : "";
        return `${band(segment.target.targetBed, segment.target.driftThreshold, "bed", segmentLeft, segmentWidth)}${band(segment.target.targetWake, segment.target.driftThreshold, "wake", segmentLeft, segmentWidth)}${changeLine}`;
      })
      .join("");
  }

  function makeTimeTicks(min, max, step) {
    const ticks = [];
    const first = Math.ceil(min / step) * step;
    for (let tick = first; tick <= max; tick += step) ticks.push(tick);
    if (!ticks.includes(min)) ticks.unshift(min);
    if (!ticks.includes(max)) ticks.push(max);
    return ticks;
  }

  function renderDayDetail(model) {
    const item = model.selectedItem;
    if (!item) {
      els.dayDetail.hidden = false;
      els.dayDetail.classList.add("is-empty");
      els.dayDetail.innerHTML = `
        <div>
          <p class="detail-eyebrow">日期详情</p>
          <h3>选择任意日期</h3>
          <p>点击月度趋势中的一晚，查看准确时间、影响因素与备注。</p>
        </div>
      `;
      return;
    }

    const index = model.items.findIndex((candidate) => candidate.date === item.date);
    const previous = model.items[index - 1];
    const next = model.items[index + 1];
    const reasons = item.targetReasons.length
      ? item.targetReasons.map((reason) => `<span class="reason-pill">${escapeHtml(reason)}</span>`).join("")
      : '<span class="reason-pill stable">目标范围内</span>';
    const tagsMarkup = item.tags.length
      ? `<div class="detail-tags">${item.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
      : "";

    els.dayDetail.hidden = false;
    els.dayDetail.classList.remove("is-empty");
    els.dayDetail.innerHTML = `
      <header class="night-detail-header">
        <div>
          <p class="detail-eyebrow">已选日期</p>
          <h3>${formatDate(item.date)}</h3>
        </div>
        <button class="detail-close" type="button" data-detail-action="close" aria-label="关闭日期详情">
          <i data-lucide="x"></i>
        </button>
      </header>
      <div class="night-detail-stats">
        <div><span>入睡</span><strong class="sleep-text">${item.bedTime}</strong></div>
        <div><span>起床</span><strong class="wake-text">${item.wakeTime}</strong></div>
        <div><span>睡眠时长</span><strong>${formatDurationLong(item.duration)}</strong></div>
      </div>
      <div class="detail-section">
        <span class="detail-label">状态</span>
        <div class="reason-list">${reasons}</div>
      </div>
      <div class="detail-section">
        <span class="detail-label">当日目标</span>
        <p class="detail-note">入睡 ${item.appliedTarget.targetBed} · 起床 ${item.appliedTarget.targetWake} · 允许偏差 ${item.appliedTarget.driftThreshold} 分钟</p>
      </div>
      ${tagsMarkup}
      ${item.note ? `<div class="detail-section"><span class="detail-label">备注</span><p class="detail-note">${escapeHtml(item.note)}</p></div>` : ""}
      <button class="detail-edit" type="button" data-detail-action="edit">
        <i data-lucide="pencil"></i>
        编辑这晚记录
      </button>
      <div class="detail-pager">
        <button type="button" data-detail-action="previous" ${previous ? "" : "disabled"}>
          <i data-lucide="chevron-left"></i>
          上一晚
        </button>
        <span>${index + 1} / ${model.items.length}</span>
        <button type="button" data-detail-action="next" ${next ? "" : "disabled"}>
          下一晚
          <i data-lucide="chevron-right"></i>
        </button>
      </div>
    `;
  }

  function handleTrendClick(event) {
    const day = event.target.closest("[data-date]");
    if (day) {
      selectTrendDate(day.dataset.date);
      return;
    }
    const monthHit = event.target.closest(".month-hit");
    if (monthHit) selectNearestMonthDate(event, monthHit.dataset.month);
  }

  function handleTrendKeydown(event) {
    const day = event.target.closest("[data-date]");
    const monthHit = event.target.closest(".month-hit");
    if (day && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      selectTrendDate(day.dataset.date, { focus: true });
      return;
    }
    if ((day || monthHit) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      moveTrendSelection(event.key === "ArrowLeft" ? -1 : 1, monthHit && monthHit.dataset.month);
      return;
    }
    if ((day || monthHit) && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const monthKey = monthHit ? monthHit.dataset.month : day.dataset.date.slice(0, 7);
      selectMonthEdge(monthKey, event.key === "Home" ? "first" : "last");
      return;
    }
    if (monthHit && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const month = trendUi.model.months.find((candidate) => candidate.key === monthHit.dataset.month);
      const item = month && month.days.map((candidate) => candidate.item).filter(Boolean)[0];
      if (item) selectTrendDate(item.date, { focus: true });
    }
  }

  function selectNearestMonthDate(event, monthKey) {
    const model = trendUi.model;
    const month = model.months.find((candidate) => candidate.key === monthKey);
    const svg = event.target.closest("svg");
    if (!month || !svg) return;
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const frame = getMonthChartFrame();
    const left = frame.margin.left;
    const right = frame.margin.right;
    const plotWidth = viewBox.width - left - right;
    const svgX = ((event.clientX - rect.left) / rect.width) * viewBox.width;
    const targetIndex = Math.round(clamp((svgX - left) / plotWidth, 0, 1) * Math.max(0, month.days.length - 1));
    let distance = 0;
    while (distance < month.days.length) {
      const leftDay = month.days[targetIndex - distance];
      const rightDay = month.days[targetIndex + distance];
      const item = (leftDay && leftDay.item) || (rightDay && rightDay.item);
      if (item) {
        selectTrendDate(item.date);
        return;
      }
      distance += 1;
    }
  }

  function selectTrendDate(date, options = {}) {
    trendUi.selectedDate = date;
    renderChart();
    if (options.focus) {
      requestAnimationFrame(() => {
        const target = els.monthCharts.querySelector(`[data-date="${date}"]`);
        target && target.focus();
      });
    }
  }

  function moveTrendSelection(delta, monthKey = "") {
    const items = monthKey
      ? trendUi.model.items.filter((item) => item.date.startsWith(monthKey))
      : trendUi.model.items;
    if (!items.length) return;
    let index = items.findIndex((item) => item.date === trendUi.selectedDate);
    if (index < 0) index = delta > 0 ? -1 : items.length;
    const next = items[clamp(index + delta, 0, items.length - 1)];
    if (next) selectTrendDate(next.date, { focus: true });
  }

  function selectMonthEdge(monthKey, edge) {
    const items = trendUi.model.items.filter((item) => item.date.startsWith(monthKey));
    const item = edge === "last" ? items.at(-1) : items[0];
    if (item) selectTrendDate(item.date, { focus: true });
  }

  function clearTrendSelection() {
    const restoreDate = trendUi.selectedDate;
    trendUi.selectedDate = "";
    renderChart();
    if (restoreDate) {
      requestAnimationFrame(() => {
        const target = els.monthCharts.querySelector(`[data-date="${restoreDate}"]`);
        target && target.focus();
      });
    }
  }

  function handleDetailAction(event) {
    const button = event.target.closest("[data-detail-action]");
    if (!button) return;
    const action = button.dataset.detailAction;
    if (action === "close") clearTrendSelection();
    if (action === "previous") moveTrendSelection(-1);
    if (action === "next") moveTrendSelection(1);
    if (action === "edit" && trendUi.model.selectedItem) editEntry(trendUi.model.selectedItem);
  }

  function handleMonthJump(event) {
    const button = event.target.closest("[data-month-target]");
    if (!button) return;
    const target = document.querySelector(`#month-${button.dataset.monthTarget}`);
    target && target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function toggleMedian() {
    trendUi.showMedian = els.medianToggle.checked;
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ showMedian: trendUi.showMedian }));
    renderChart();
  }

  function trendDayAriaLabel(item) {
    const stateLabel = item.targetReasons.length ? `，偏离：${item.targetReasons.join("、")}` : "，目标范围内";
    return `${formatDate(item.date)}，入睡 ${item.bedTime}，起床 ${item.wakeTime}，睡眠 ${formatDurationLong(item.duration)}${stateLabel}`;
  }

  function formatDurationLong(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins ? `${hours}小时${mins}分钟` : `${hours}小时`;
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function renderAnomalies(analysis) {
    const anomalies = analysis.items.filter((item) => item.targetReasons.length).reverse();
    if (!anomalies.length) {
      els.anomalyList.innerHTML = '<p class="muted">暂无明显偏离。</p>';
      return;
    }

    els.anomalyList.innerHTML = anomalies
      .map(
        (item) => `
          <article class="anomaly-item">
            <p class="item-title">${formatDate(item.date)}</p>
            <p class="item-meta">入睡 ${item.bedTime} · 起床 ${item.wakeTime} · ${formatDuration(item.duration)}</p>
            <div class="reason-list">
              ${item.targetReasons.map((reason) => `<span class="reason-pill">${escapeHtml(reason)}</span>`).join("")}
            </div>
            ${item.note ? `<p class="note-text">${escapeHtml(item.note)}</p>` : ""}
          </article>
        `,
      )
      .join("");
  }

  function renderEntries(analysis) {
    if (!analysis.items.length) {
      els.entryList.innerHTML = '<p class="muted">暂无记录。</p>';
      return;
    }

    els.entryList.innerHTML = analysis.items
      .slice()
      .reverse()
      .map(
        (item) => `
          <article class="entry-item">
            <div class="item-row">
              <div>
                <p class="item-title">${formatDate(item.date)}</p>
                <p class="item-meta">入睡 ${item.bedTime} · 起床 ${item.wakeTime} · ${formatDuration(item.duration)}</p>
              </div>
              <div class="entry-actions">
                <button class="mini-button" type="button" data-action="edit" data-id="${item.id}" title="编辑" aria-label="编辑">
                  <i data-lucide="pencil"></i>
                </button>
                <button class="mini-button delete" type="button" data-action="delete" data-id="${item.id}" title="删除" aria-label="删除">
                  <i data-lucide="trash-2"></i>
                </button>
              </div>
            </div>
            ${item.tags.length ? `<div class="reason-list">${item.tags.map((tag) => `<span class="reason-pill">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
            ${item.note ? `<p class="note-text">${escapeHtml(item.note)}</p>` : ""}
          </article>
        `,
      )
      .join("");

    els.entryList.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const entry = state.entries.find((item) => item.id === button.dataset.id);
        if (!entry) return;
        if (button.dataset.action === "edit") editEntry(entry);
        if (button.dataset.action === "delete") deleteEntry(entry.id);
      });
    });
    window.lucide && window.lucide.createIcons();
  }

  function editEntry(entry) {
    els.editingId.value = entry.id;
    els.sleepDate.value = entry.date;
    els.bedTime.value = entry.bedTime;
    els.wakeTime.value = entry.wakeTime;
    els.note.value = entry.note || "";
    renderTags(entry.tags || []);
    els.form.querySelector(".primary-button").innerHTML = '<i data-lucide="save"></i>更新记录';
    window.lucide && window.lucide.createIcons();
    els.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function deleteEntry(id) {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry || !confirm(`删除 ${formatDate(entry.date)} 的记录？`)) return;
    state.entries = state.entries.filter((item) => item.id !== id);
    persistEntries();
    queueCloudDelete(id);
    render();
  }

  function clearAll() {
    if (!state.entries.length) return;
    if (!confirm("清空所有记录？")) return;
    const deletedIds = state.entries.map((entry) => entry.id);
    state.entries = [];
    persistEntries();
    queueCloudDeletes(deletedIds);
    resetEntryForm();
    render();
  }

  async function initCloudSync() {
    setCloudUi("checking", "正在检查云同步配置...");
    try {
      const configModule = await import("./firebase-config.js");
      const config = configModule.firebaseConfig;
      if (!config || !config.apiKey || !config.projectId || !config.appId) {
        setCloudUi("local", "未配置 Firebase，当前使用本地保存。");
        return;
      }

      const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
      ]);

      const app = initializeApp(config);
      syncState.auth = authModule.getAuth(app);
      syncState.db = firestoreModule.getFirestore(app);
      syncState.provider = new authModule.GoogleAuthProvider();
      syncState.firebase = { auth: authModule, firestore: firestoreModule };
      syncState.configured = true;
      await initGoogleIdentity(config.googleClientId);

      authModule.onAuthStateChanged(syncState.auth, async (user) => {
        syncState.user = user;
        syncState.ready = Boolean(user);
        renderCloudUi();
        if (user) {
          await loadCloudData();
        }
      });
      renderCloudUi();
    } catch (error) {
      console.error(error);
      setCloudUi("error", "云同步初始化失败，请检查 Firebase 配置。");
    }
  }

  async function signInWithGoogle() {
    if (!syncState.configured) return;
    setCloudUi("checking", "正在打开 Google 登录...");
    try {
      await syncState.firebase.auth.signInWithPopup(syncState.auth, syncState.provider);
    } catch (error) {
      console.error(error);
      setCloudUi("error", authErrorMessage(error));
    }
  }

  async function initGoogleIdentity(clientId) {
    if (!clientId) return;
    try {
      await loadScript("https://accounts.google.com/gsi/client");
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleIdentityCredential,
      });
      window.google.accounts.id.renderButton(els.googleButtonHost, {
        shape: "rectangular",
        size: "large",
        text: "signin_with",
        theme: "outline",
        width: 245,
      });
      syncState.googleReady = true;
    } catch (error) {
      console.error(error);
      syncState.googleReady = false;
    }
  }

  async function handleGoogleIdentityCredential(response) {
    if (!response || !response.credential || !syncState.firebase) {
      setCloudUi("error", "Google 登录没有返回凭证，请重试。");
      return;
    }
    setCloudUi("checking", "正在完成登录...");
    try {
      const credential = syncState.firebase.auth.GoogleAuthProvider.credential(response.credential);
      await syncState.firebase.auth.signInWithCredential(syncState.auth, credential);
    } catch (error) {
      console.error(error);
      setCloudUi("error", authErrorMessage(error));
    }
  }

  async function signOutCloud() {
    if (!syncState.auth) return;
    await syncState.firebase.auth.signOut(syncState.auth);
    syncState.ready = false;
    syncState.user = null;
    renderCloudUi();
  }

  async function refreshCloudData() {
    if (!syncState.ready || !syncState.firebase) return;
    clearTimeout(syncState.pendingTimer);
    const flushed = await flushCloudQueue();
    await loadCloudData({ flushPending: false });
    if (!flushed && hasPendingCloudOperations()) {
      setCloudUi("error", "已重新读取云端，但待处理更改尚未同步。");
    }
  }

  async function loadCloudData(options = {}) {
    if (!syncState.ready || syncState.loading) return false;
    syncState.loading = true;
    setCloudUi("checking", "正在读取云端记录...");
    let shouldFlush = false;
    try {
      const { collection, doc, getDoc, getDocs } = syncState.firebase.firestore;
      const settingsRef = doc(syncState.db, "users", syncState.user.uid, "profile", "settings");
      const entriesRef = collection(syncState.db, "users", syncState.user.uid, "entries");
      const [settingsSnapshot, entriesSnapshot] = await Promise.all([getDoc(settingsRef), getDocs(entriesRef)]);
      const rawCloudSettings = settingsSnapshot.exists() ? settingsSnapshot.data() : null;
      const cloudSettings = sanitizeSettings(rawCloudSettings || defaultSettings, {
        migrateLegacyThreshold: true,
      });
      const shouldUpgradeCloudSettings = !rawCloudSettings || settingsNeedCloudUpgrade(rawCloudSettings, cloudSettings);
      const shouldBackfillCloudSnapshots = Boolean(
        rawCloudSettings && !trendCore.sanitizeTargetHistory(rawCloudSettings.targetHistory).length,
      );
      const legacyTargetHistory = shouldBackfillCloudSnapshots
        ? legacyTargetHistoryForSettings(rawCloudSettings)
        : [];
      const cloudEntries = entriesSnapshot.docs
        .map((entryDoc) => ({ ...entryDoc.data(), id: entryDoc.id }))
        .filter(isValidEntry)
        .map(normalizeEntryForSave);
      const overlay = applyPendingCloudOperations(cloudEntries, cloudSettings);
      const snapshotBackfill = shouldBackfillCloudSnapshots
        ? backfillTargetSnapshots(overlay.entries, legacyTargetHistory)
        : { entries: overlay.entries, upserts: [] };

      state.settings = overlay.settings;
      state.entries = snapshotBackfill.entries;
      sortEntries();
      persistLocalOnly();
      hydrateForms();
      render();
      if (snapshotBackfill.upserts.length) queueCloudUpserts(snapshotBackfill.upserts);
      if (shouldUpgradeCloudSettings) queueCloudSettings(state.settings);
      syncState.lastSyncAt = new Date().toISOString();
      shouldFlush = hasPendingCloudOperations();
      setCloudUi("synced", `已读取云端：${cloudUserLabel(syncState.user)}`);
      return true;
    } catch (error) {
      console.error(error);
      setCloudUi("error", "读取云端记录失败，请检查 Firestore 是否已开启并配置规则。");
      return false;
    } finally {
      syncState.loading = false;
      if (shouldFlush && options.flushPending !== false) {
        await flushCloudQueue();
      }
    }
  }

  async function flushCloudQueue() {
    if (!syncState.ready || !syncState.firebase) {
      updateTrendSourceStatus("local");
      return false;
    }
    if (syncState.flushPromise) return syncState.flushPromise;
    if (syncState.loading) {
      scheduleCloudSave();
      return false;
    }

    const promise = performCloudQueueFlush();
    syncState.flushPromise = promise;
    try {
      return await promise;
    } finally {
      if (syncState.flushPromise === promise) syncState.flushPromise = null;
    }
  }

  async function performCloudQueueFlush() {
    clearTimeout(syncState.pendingTimer);
    const snapshot = cloudQueue.operations.slice();
    if (!snapshot.length) {
      updateTrendSourceStatus("synced");
      return true;
    }

    const compacted = compactCloudOperations(snapshot);
    const writes = [...compacted.entryOperations];
    if (compacted.settingsOperation) writes.push(compacted.settingsOperation);
    setCloudUi("checking", `正在同步 ${writes.length} 项更改...`);

    try {
      const { collection, doc, writeBatch } = syncState.firebase.firestore;
      const settingsRef = doc(syncState.db, "users", syncState.user.uid, "profile", "settings");
      const entriesRef = collection(syncState.db, "users", syncState.user.uid, "entries");
      const batchSize = 450;

      for (let offset = 0; offset < writes.length; offset += batchSize) {
        const batch = writeBatch(syncState.db);
        writes.slice(offset, offset + batchSize).forEach((operation) => {
          if (operation.type === "upsert") {
            batch.set(doc(entriesRef, operation.entry.id), operation.entry, { merge: true });
          }
          if (operation.type === "delete") {
            batch.delete(doc(entriesRef, operation.id));
          }
          if (operation.type === "settings") {
            batch.set(settingsRef, operation.settings, { merge: true });
          }
        });
        await batch.commit();
      }

      cloudQueue.operations.splice(0, snapshot.length);
      persistCloudQueue();
      syncState.lastSyncAt = new Date().toISOString();
      setCloudUi("synced", "云端已同步。");
      if (hasPendingCloudOperations()) scheduleCloudSave();
      return true;
    } catch (error) {
      console.error(error);
      setCloudUi("error", "同步失败，请稍后重试。");
      return false;
    }
  }

  function scheduleCloudSave(delay = 650) {
    clearTimeout(syncState.pendingTimer);
    if (!syncState.ready || !syncState.firebase) {
      updateTrendSourceStatus("local");
      return;
    }
    syncState.pendingTimer = setTimeout(() => flushCloudQueue(), delay);
    setCloudUi("checking", "等待同步...");
  }

  function renderCloudUi() {
    if (!syncState.configured) {
      setCloudUi("local", "未配置 Firebase，当前使用本地保存。");
      return;
    }
    if (!syncState.user) {
      setCloudUi("local", "登录后可在不同设备同步记录。");
      els.googleButtonHost.hidden = !syncState.googleReady;
      els.signInBtn.hidden = syncState.googleReady;
      els.signOutBtn.hidden = true;
      els.syncNowBtn.hidden = true;
      return;
    }
    setCloudUi("checking", `已登录：${cloudUserLabel(syncState.user)}，正在读取云端...`);
    els.signInBtn.hidden = true;
    els.googleButtonHost.hidden = true;
    els.signOutBtn.hidden = false;
    els.syncNowBtn.hidden = false;
  }

  function setCloudUi(status, message) {
    const badgeText = {
      checking: "同步中",
      error: "异常",
      local: "本地",
      synced: "云端",
    };
    els.cloudBadge.textContent = badgeText[status] || "本地";
    els.cloudBadge.dataset.status = status;
    els.cloudStatus.textContent = message;
    updateTrendSourceStatus(status);
    if (!syncState.configured) {
      els.signInBtn.hidden = true;
      els.googleButtonHost.hidden = true;
      els.signOutBtn.hidden = true;
      els.syncNowBtn.hidden = true;
      return;
    }
    if (status !== "local" || syncState.configured) {
      els.signInBtn.hidden = syncState.ready;
      els.googleButtonHost.hidden = syncState.ready || !syncState.googleReady;
      els.signOutBtn.hidden = !syncState.ready;
      els.syncNowBtn.hidden = !syncState.ready;
    }
    window.lucide && window.lucide.createIcons();
  }

  function updateTrendSourceStatus(status = "local") {
    if (!els.trendSourceStatus) return;
    const pendingCount = pendingCloudOperationCount();
    const syncedAt = syncState.lastSyncAt
      ? new Date(syncState.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : "";
    const icon = {
      checking: "refresh-cw",
      error: "cloud-off",
      local: "database",
      synced: "cloud-check",
    }[status] || "database";
    let label = "本地缓存";

    if (status === "checking") label = pendingCount ? `正在同步 · ${pendingCount} 项待处理` : "正在读取云端";
    if (status === "error") label = pendingCount ? `同步异常 · ${pendingCount} 项待处理` : "云端读取异常";
    if (status === "local" && pendingCount) label = `本地缓存 · ${pendingCount} 项待同步`;
    if (status === "synced") {
      label = pendingCount ? `云端数据 · ${pendingCount} 项待同步` : `云端数据${syncedAt ? ` · ${syncedAt}` : ""}`;
    }

    els.trendSourceStatus.dataset.status = status;
    els.trendSourceStatus.innerHTML = `<i data-lucide="${icon}"></i><span>${escapeHtml(label)}</span>`;
    window.lucide && window.lucide.createIcons();
  }

  function cloudUserLabel(user) {
    if (!user) return "当前账号";
    if (user.isAnonymous) return "匿名账号";
    return user.displayName || user.email || "Google 账号";
  }

  function authErrorMessage(error) {
    const code = error && error.code ? `（${error.code}）` : "";
    if (error && error.code === "auth/popup-blocked") {
      return "登录弹窗被浏览器拦截，请允许弹窗后重试。";
    }
    if (error && error.code === "auth/popup-closed-by-user") {
      return "登录窗口已关闭，请重新点击 Google 登录。";
    }
    return `登录失败${code}。请确认 Firebase 已启用 Google 登录，并添加 GitHub Pages 授权域名。`;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        if (window.google) resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }

  function analyzeEntries() {
    const normalizedEntries = trendCore.dedupeEntriesByDate(state.entries);
    const analysis = trendCore.analyzeEntries(normalizedEntries, state.settings);
    return {
      items: analysis.items.map((item) => ({
        ...item,
        targetReasonDetails: item.targetReasons,
        targetReasons: item.targetReasons.map(formatTargetReason),
      })),
    };
  }

  function formatTargetReason(reason) {
    if (reason.type === "late-bed") return `晚睡 ${formatDelta(reason.minutes)}`;
    if (reason.type === "late-wake") return `晚起 ${formatDelta(reason.minutes)}`;
    if (reason.type === "short-sleep") return "睡眠不足 6 小时";
    return "偏离目标";
  }

  function countStableDays(items) {
    let count = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (!items[index].stable) break;
      count += 1;
    }
    return count;
  }

  function recoveryLabel(items) {
    let lastAnomalyIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].targetReasons.length) {
        lastAnomalyIndex = index;
        break;
      }
    }
    if (lastAnomalyIndex === -1) return "一直稳定";
    const daysAfter = items.length - lastAnomalyIndex - 1;
    if (daysAfter <= 0) return "恢复中";
    return `${daysAfter} 天`;
  }

  function exportCsv() {
    const header = ["日期", "入睡时间", "起床时间", "睡眠时长", "当日目标入睡", "当日目标起床", "偏离阈值", "影响因素", "备注"];
    const rows = analyzeEntries().items.map((item) => [
      item.date,
      item.bedTime,
      item.wakeTime,
      formatDuration(item.duration),
      item.appliedTarget.targetBed,
      item.appliedTarget.targetWake,
      item.appliedTarget.driftThreshold,
      item.tags.join("；"),
      item.note || "",
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    download(`sleep-rhythm-${todayString()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  function exportJson() {
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      entries: state.entries,
    };
    download(`sleep-rhythm-${todayString()}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  function importJson(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        if (!Array.isArray(payload.entries)) throw new Error("missing entries");
        const previousByDate = new Map(state.entries.map((entry) => [entry.date, entry]));
        const importedEntries = trendCore
          .dedupeEntriesByDate(payload.entries.filter(isValidEntry).map(normalizeEntryForSave));
        const importedWinners = importedEntries.filter((entry) => {
          const current = previousByDate.get(entry.date);
          return !current || (Date.parse(entry.updatedAt || "") || 0) >= (Date.parse(current.updatedAt || "") || 0);
        });
        state.entries = mergeEntries(state.entries, importedEntries);
        state.settings = sanitizeSettings(payload.settings || state.settings);
        persistEntries();
        persistSettings();
        queueCloudImport(importedWinners, state.settings);
        hydrateForms();
        render();
      } catch (error) {
        alert("导入失败，请检查 JSON 文件。");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  function loadEntries() {
    try {
      const entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(entries)
        ? trendCore.dedupeEntriesByDate(entries.filter(isValidEntry).map(normalizeEntryForSave))
        : [];
    } catch {
      return [];
    }
  }

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (!trendCore.sanitizeTargetHistory(stored.targetHistory).length) {
        pendingLocalSnapshotHistory = legacyTargetHistoryForSettings(stored);
      }
      return sanitizeSettings(stored, { migrateLegacyThreshold: true });
    } catch {
      return sanitizeSettings(defaultSettings);
    }
  }

  function loadChartPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(CHART_PREFS_KEY) || "{}");
      return { showMedian: stored.showMedian !== false };
    } catch {
      return { showMedian: true };
    }
  }

  function loadCloudQueue() {
    try {
      const stored = JSON.parse(localStorage.getItem(CLOUD_QUEUE_KEY) || "{}");
      const candidates = Array.isArray(stored) ? stored : Array.isArray(stored.operations) ? stored.operations : [];

      if (!candidates.length && stored && typeof stored === "object") {
        const legacyUpserts = Array.isArray(stored.upserts)
          ? stored.upserts
          : stored.upserts && typeof stored.upserts === "object"
            ? Object.values(stored.upserts)
            : [];
        legacyUpserts.forEach((entry) => candidates.push({ type: "upsert", entry }));
        const legacyDeletes = Array.isArray(stored.deletes)
          ? stored.deletes
          : stored.deletes && typeof stored.deletes === "object"
            ? Object.keys(stored.deletes)
            : [];
        legacyDeletes.forEach((id) => candidates.push({ type: "delete", id }));
        if (stored.settings) candidates.push({ type: "settings", settings: stored.settings });
      }

      return {
        version: 1,
        operations: candidates.map(sanitizeCloudOperation).filter(Boolean),
      };
    } catch {
      return { version: 1, operations: [] };
    }
  }

  function sanitizeCloudOperation(operation) {
    if (!operation || typeof operation !== "object") return null;
    if (operation.type === "upsert" && isValidEntry(operation.entry)) {
      return { type: "upsert", entry: normalizeEntryForSave(operation.entry) };
    }
    if (operation.type === "delete" && typeof operation.id === "string" && operation.id) {
      return { type: "delete", id: operation.id };
    }
    if (operation.type === "settings" && operation.settings && typeof operation.settings === "object") {
      return { type: "settings", settings: sanitizeSettings(operation.settings) };
    }
    return null;
  }

  function persistCloudQueue() {
    try {
      localStorage.setItem(CLOUD_QUEUE_KEY, JSON.stringify(cloudQueue));
    } catch (error) {
      console.warn("无法保存云同步队列。", error);
    }
  }

  function enqueueCloudOperations(operations) {
    const validOperations = operations.map(sanitizeCloudOperation).filter(Boolean);
    if (!validOperations.length) return;
    cloudQueue.operations.push(...validOperations);
    persistCloudQueue();
    scheduleCloudSave();
  }

  function queueCloudUpsert(entry) {
    enqueueCloudOperations([{ type: "upsert", entry }]);
  }

  function queueCloudUpserts(entries) {
    enqueueCloudOperations(entries.map((entry) => ({ type: "upsert", entry })));
  }

  function queueCloudDelete(id) {
    enqueueCloudOperations([{ type: "delete", id }]);
  }

  function queueCloudDeletes(ids) {
    enqueueCloudOperations(ids.map((id) => ({ type: "delete", id })));
  }

  function queueCloudSettings(settings) {
    enqueueCloudOperations([{ type: "settings", settings }]);
  }

  function queueCloudImport(importedEntries, settings) {
    const operations = [];
    importedEntries.forEach((entry) => operations.push({ type: "upsert", entry }));
    operations.push({ type: "settings", settings });
    enqueueCloudOperations(operations);
  }

  function compactCloudOperations(operations = cloudQueue.operations) {
    const entryById = new Map();
    let settingsOperation = null;
    operations.map(sanitizeCloudOperation).filter(Boolean).forEach((operation) => {
      if (operation.type === "upsert") entryById.set(operation.entry.id, operation);
      if (operation.type === "delete") entryById.set(operation.id, operation);
      if (operation.type === "settings") settingsOperation = operation;
    });
    return {
      entryOperations: Array.from(entryById.values()),
      settingsOperation,
    };
  }

  function hasPendingCloudOperations() {
    return cloudQueue.operations.length > 0;
  }

  function pendingCloudOperationCount() {
    const compacted = compactCloudOperations();
    return compacted.entryOperations.length + (compacted.settingsOperation ? 1 : 0);
  }

  function applyPendingCloudOperations(cloudEntries, cloudSettings) {
    const baseEntries = mergeEntries([], cloudEntries);
    const entriesById = new Map(baseEntries.map((entry) => [entry.id, normalizeEntryForSave(entry)]));
    let settings = sanitizeSettings(cloudSettings, { migrateLegacyThreshold: true });

    cloudQueue.operations.map(sanitizeCloudOperation).filter(Boolean).forEach((operation) => {
      if (operation.type === "delete") entriesById.delete(operation.id);
      if (operation.type === "upsert") {
        entriesById.forEach((entry, id) => {
          if (id !== operation.entry.id && entry.date === operation.entry.date) entriesById.delete(id);
        });
        entriesById.set(operation.entry.id, operation.entry);
      }
      if (operation.type === "settings") settings = operation.settings;
    });

    return {
      entries: Array.from(entriesById.values()).sort(byDateValue),
      settings,
    };
  }

  function isValidEntry(entry) {
    return (
      entry &&
      entry.id &&
      trendCore.isValidDateString(entry.date) &&
      trendCore.isValidTimeString(entry.bedTime) &&
      trendCore.isValidTimeString(entry.wakeTime)
    );
  }

  function persistEntries() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
  }

  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function persistLocalOnly() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function mergeEntries(localEntries, cloudEntries) {
    return trendCore.dedupeEntriesByDate(
      [...localEntries, ...cloudEntries].filter(isValidEntry).map(normalizeEntryForSave),
    );
  }

  function sanitizeSettings(settings = {}, options = {}) {
    const source = settings && typeof settings === "object" ? settings : {};
    const rawThreshold = Number(source.driftThreshold);
    const threshold = Number.isFinite(rawThreshold)
      ? clamp(rawThreshold, 15, 120)
      : defaultSettings.driftThreshold;
    let currentTarget = {
      targetBed: trendCore.isValidTimeString(source.targetBed) ? source.targetBed : defaultSettings.targetBed,
      targetWake: trendCore.isValidTimeString(source.targetWake) ? source.targetWake : defaultSettings.targetWake,
      driftThreshold:
        options.migrateLegacyThreshold && threshold === legacyDefaultSettings.driftThreshold
          ? defaultSettings.driftThreshold
          : threshold,
    };
    let targetHistory = trendCore
      .sanitizeTargetHistory(source.targetHistory)
      .map((target) => ({ ...target, driftThreshold: clamp(target.driftThreshold, 15, 120) }));
    const hasExplicitTarget =
      trendCore.isValidTimeString(source.targetBed) && trendCore.isValidTimeString(source.targetWake);
    const shouldRestoreKnownHistory =
      options.migrateKnownHistory !== false &&
      !targetHistory.length &&
      currentTarget.targetBed === "23:00" &&
      ["06:30", "06:50", "07:00"].includes(currentTarget.targetWake) &&
      currentTarget.driftThreshold === 30;

    if (shouldRestoreKnownHistory) {
      targetHistory = knownTargetHistory.map((target) => ({ ...target }));
      currentTarget = { ...defaultSettings };
    } else if (!targetHistory.length) {
      targetHistory = [
        {
          effectiveFrom: hasExplicitTarget ? "0001-01-01" : WAKE_620_EFFECTIVE_FROM,
          ...currentTarget,
        },
      ];
      if (currentTarget.targetWake !== defaultSettings.targetWake) {
        currentTarget = { ...currentTarget, targetWake: defaultSettings.targetWake };
        targetHistory = trendCore.upsertTargetHistory(
          targetHistory,
          currentTarget,
          WAKE_620_EFFECTIVE_FROM,
        );
      }
    }

    const activeTarget = trendCore.resolveTargetForDate({ date: todayString() }, { targetHistory });
    return {
      targetBed: activeTarget.targetBed,
      targetWake: activeTarget.targetWake,
      driftThreshold: activeTarget.driftThreshold,
      targetHistoryVersion: TARGET_HISTORY_VERSION,
      targetHistory,
    };
  }

  function legacyTargetHistoryForSettings(settings = {}) {
    const rawThreshold = Number(settings.driftThreshold);
    const threshold = Number.isFinite(rawThreshold)
      ? clamp(
          rawThreshold === legacyDefaultSettings.driftThreshold
            ? defaultSettings.driftThreshold
            : rawThreshold,
          15,
          120,
        )
      : defaultSettings.driftThreshold;
    const legacyTarget = {
      targetBed: trendCore.isValidTimeString(settings.targetBed) ? settings.targetBed : defaultSettings.targetBed,
      targetWake: trendCore.isValidTimeString(settings.targetWake) ? settings.targetWake : defaultSettings.targetWake,
      driftThreshold: threshold,
    };
    const matchesKnownHistory =
      legacyTarget.targetBed === "23:00" &&
      ["06:30", "06:50", "07:00"].includes(legacyTarget.targetWake) &&
      legacyTarget.driftThreshold === 30;
    return matchesKnownHistory
      ? knownTargetHistory.slice(0, -1).map((target) => ({ ...target }))
      : [{ effectiveFrom: "0001-01-01", ...legacyTarget }];
  }

  function backfillTargetSnapshots(entries, targetHistory) {
    const upserts = [];
    const migratedEntries = entries.map((entry) => {
      if (normalizeTargetSnapshot(entry.targetSnapshot)) return entry;
      const target = trendCore.resolveTargetForDate({ date: entry.date }, { targetHistory });
      const migrated = {
        ...entry,
        targetSnapshot: {
          targetBed: target.targetBed,
          targetWake: target.targetWake,
          driftThreshold: target.driftThreshold,
          effectiveFrom: target.effectiveFrom || entry.date,
        },
      };
      upserts.push(migrated);
      return migrated;
    });
    return { entries: migratedEntries, upserts };
  }

  function normalizeEntryForSave(entry) {
    const normalized = {
      id: entry.id,
      date: entry.date,
      bedTime: entry.bedTime,
      wakeTime: entry.wakeTime,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => tags.includes(tag)) : [],
      note: entry.note || "",
      updatedAt: entry.updatedAt || new Date().toISOString(),
    };
    const targetSnapshot = normalizeTargetSnapshot(entry.targetSnapshot);
    if (targetSnapshot) normalized.targetSnapshot = targetSnapshot;
    return normalized;
  }

  function normalizeTargetSnapshot(targetSnapshot) {
    if (!trendCore.isValidTargetConfig(targetSnapshot)) return null;
    const normalized = {
      targetBed: targetSnapshot.targetBed,
      targetWake: targetSnapshot.targetWake,
      driftThreshold: clamp(Number(targetSnapshot.driftThreshold), 15, 120),
    };
    if (trendCore.isValidDateString(targetSnapshot.effectiveFrom)) {
      normalized.effectiveFrom = targetSnapshot.effectiveFrom;
    }
    return normalized;
  }

  function makeTargetSnapshot(date, existingSnapshot) {
    const existing = normalizeTargetSnapshot(existingSnapshot);
    if (existing) return existing;
    const target = trendCore.resolveTargetForDate({ date }, state.settings);
    return {
      targetBed: target.targetBed,
      targetWake: target.targetWake,
      driftThreshold: target.driftThreshold,
      effectiveFrom: target.effectiveFrom || date,
    };
  }

  function settingsNeedCloudUpgrade(raw, sanitized) {
    const rawHistory = trendCore.sanitizeTargetHistory(raw && raw.targetHistory);
    return Boolean(
      !raw ||
        raw.targetHistoryVersion !== TARGET_HISTORY_VERSION ||
        raw.targetBed !== sanitized.targetBed ||
        raw.targetWake !== sanitized.targetWake ||
        Number(raw.driftThreshold) !== Number(sanitized.driftThreshold) ||
        JSON.stringify(rawHistory) !== JSON.stringify(sanitized.targetHistory),
    );
  }

  function sortEntries() {
    state.entries.sort(byDateValue);
  }

  function byDateValue(a, b) {
    return a.date.localeCompare(b.date);
  }

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `${hours}h${String(mins).padStart(2, "0")}`;
  }

  function formatDelta(minutes) {
    if (minutes < 60) return `${Math.round(minutes)} 分钟`;
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  }

  function formatAxisTime(minutes) {
    const normalized = minutes % (24 * 60);
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:00`;
  }

  function formatDate(date) {
    const parsed = new Date(`${date}T00:00:00`);
    return parsed.toLocaleDateString("zh-CN", { month: "short", day: "numeric", weekday: "short" });
  }

  function formatHistoryDate(date) {
    if (!trendCore.isValidDateString(date)) return "今天";
    const [year, month, day] = date.split("-").map(Number);
    if (date === "0001-01-01") return "最早记录";
    return `${year}年${month}月${day}日`;
  }

  function shortDate(date) {
    const [, month, day] = date.split("-");
    return `${Number(month)}/${Number(day)}`;
  }

  function todayString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
      return map[char];
    });
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function debounce(fn, delay) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
})();
