(function () {
  const STORAGE_KEY = "sleep-rhythm.entries.v1";
  const SETTINGS_KEY = "sleep-rhythm.settings.v1";
  const FIREBASE_SDK_VERSION = "12.13.0";
  const tags = ["工作", "娱乐", "运动", "社交", "补觉", "折腾"];
  const legacyDefaultSettings = {
    targetBed: "23:30",
    targetWake: "07:30",
  };
  const defaultSettings = {
    targetBed: "23:00",
    targetWake: "07:00",
    driftThreshold: 45,
  };

  const state = {
    entries: loadEntries(),
    settings: loadSettings(),
  };
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
  };

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
    statsGrid: $("#statsGrid"),
    chart: $("#trendChart"),
    tooltip: $("#chartTooltip"),
    rangeLabel: $("#rangeLabel"),
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
  };

  init();

  function init() {
    renderTags();
    hydrateForms();
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
    els.settingsForm.addEventListener("input", saveSettings);
    els.clearAllBtn.addEventListener("click", clearAll);
    els.exportCsvBtn.addEventListener("click", exportCsv);
    els.exportJsonBtn.addEventListener("click", exportJson);
    els.importJsonInput.addEventListener("change", importJson);
    els.signInBtn.addEventListener("click", signInWithGoogle);
    els.signOutBtn.addEventListener("click", signOutCloud);
    els.syncNowBtn.addEventListener("click", syncCloudFromLocal);
    window.addEventListener("resize", debounce(renderChart, 120));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        els.tooltip.hidden = true;
      }
    });
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
  }

  function saveEntry(event) {
    event.preventDefault();
    const entry = {
      id: els.editingId.value || makeId(),
      date: els.sleepDate.value,
      bedTime: els.bedTime.value,
      wakeTime: els.wakeTime.value,
      tags: Array.from(document.querySelectorAll('input[name="tags"]:checked')).map((input) => input.value),
      note: els.note.value.trim(),
      updatedAt: new Date().toISOString(),
    };

    const currentIndex = state.entries.findIndex((item) => item.id === entry.id);
    if (currentIndex >= 0) {
      state.entries[currentIndex] = entry;
    } else {
      const sameDateIndex = state.entries.findIndex((item) => item.date === entry.date);
      if (sameDateIndex >= 0) {
        state.entries[sameDateIndex] = { ...entry, id: state.entries[sameDateIndex].id };
      } else {
        state.entries.push(entry);
      }
    }

    sortEntries();
    persistEntries();
    resetEntryForm();
    render();
  }

  function saveSettings() {
    state.settings = {
      targetBed: els.targetBed.value || defaultSettings.targetBed,
      targetWake: els.targetWake.value || defaultSettings.targetWake,
      driftThreshold: Number(els.driftThreshold.value) || defaultSettings.driftThreshold,
    };
    els.driftValue.textContent = `${state.settings.driftThreshold} 分钟`;
    persistSettings();
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
    const items = analysis.items;
    const rect = els.chart.getBoundingClientRect();
    const width = Math.max(640, Math.round(rect.width || 900));
    const height = Math.round(rect.height || 440);
    const margin = { top: 24, right: 26, bottom: 52, left: 54 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const chartRange = getChartRange(items);
    const minY = chartRange.min;
    const maxY = chartRange.max;
    const yTicks = makeHourlyTicks(minY, maxY);
    els.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);

    if (!items.length) {
      els.rangeLabel.textContent = "";
      els.chart.innerHTML = `
        <text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="empty-state">
          还没有记录
        </text>
      `;
      return;
    }

    els.rangeLabel.textContent =
      items.length === 1 ? formatDate(items[0].date) : `${formatDate(items[0].date)} - ${formatDate(items.at(-1).date)}`;

    const x = (index) => {
      if (items.length === 1) return margin.left + plotWidth / 2;
      return margin.left + (index / (items.length - 1)) * plotWidth;
    };
    const y = (minutes) => margin.top + ((minutes - minY) / (maxY - minY)) * plotHeight;
    const sleepPath = makePath(items.map((item, index) => [x(index), y(item.bedNorm)]));
    const wakePath = makePath(items.map((item, index) => [x(index), y(item.wakeNorm)]));
    const targetBedY = y(normalizeNightTime(state.settings.targetBed, "bed"));
    const targetWakeY = y(normalizeNightTime(state.settings.targetWake, "wake"));
    const dateStep = Math.max(1, Math.ceil(items.length / 7));

    const grid = yTicks
      .map(
        (tick) => `
          <line class="grid-line" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}"></line>
          <text class="axis-label" x="${margin.left - 12}" y="${y(tick) + 4}" text-anchor="end">${formatAxisTime(tick)}</text>
        `,
      )
      .join("");

    const dateLabels = items
      .map((item, index) => {
        if (index !== 0 && index !== items.length - 1 && index % dateStep !== 0) return "";
        return `<text class="date-label" x="${x(index)}" y="${height - 20}" text-anchor="middle">${shortDate(item.date)}</text>`;
      })
      .join("");

    const sleepPoints = items
      .map((item, index) => pointMarkup(item, index, x(index), y(item.bedNorm), "sleep", item.anomalyReasons.length))
      .join("");
    const wakePoints = items
      .map((item, index) => pointMarkup(item, index, x(index), y(item.wakeNorm), "wake", item.anomalyReasons.length))
      .join("");
    const timeLabels = items
      .map((item, index) => {
        if (items.length > 10 && !item.anomalyReasons.length) return "";
        const labelX = x(index);
        return `
          <text class="time-label sleep-label" x="${labelX}" y="${y(item.bedNorm) - 12}" text-anchor="middle">${item.bedTime}</text>
          <text class="time-label wake-label" x="${labelX}" y="${y(item.wakeNorm) + 20}" text-anchor="middle">${item.wakeTime}</text>
        `;
      })
      .join("");

    els.chart.innerHTML = `
      ${grid}
      <line class="target-line" x1="${margin.left}" y1="${targetBedY}" x2="${width - margin.right}" y2="${targetBedY}"></line>
      <line class="target-line" x1="${margin.left}" y1="${targetWakeY}" x2="${width - margin.right}" y2="${targetWakeY}"></line>
      <path class="trend-line sleep-line" d="${sleepPath}"></path>
      <path class="trend-line wake-line" d="${wakePath}"></path>
      ${sleepPoints}
      ${wakePoints}
      ${timeLabels}
      ${dateLabels}
    `;

    els.chart.querySelectorAll(".point").forEach((point) => {
      point.addEventListener("mouseenter", showPointTooltip);
      point.addEventListener("mousemove", moveTooltip);
      point.addEventListener("mouseleave", hideTooltip);
      point.addEventListener("click", showPointTooltip);
    });
  }

  function pointMarkup(item, index, cx, cy, kind, isAlert) {
    const className = `point ${kind}${isAlert ? " alert" : ""}`;
    return `
      <circle
        class="${className}"
        cx="${cx}"
        cy="${cy}"
        r="${isAlert ? 6 : 5}"
        data-index="${index}"
        data-kind="${kind}"
        tabindex="0"
      ></circle>
    `;
  }

  function showPointTooltip(event) {
    const point = event.currentTarget;
    const analysis = analyzeEntries();
    const item = analysis.items[Number(point.dataset.index)];
    const kind = point.dataset.kind === "sleep" ? "入睡" : "起床";
    const time = point.dataset.kind === "sleep" ? item.bedTime : item.wakeTime;
    const reasons = item.anomalyReasons.length ? item.anomalyReasons.join("、") : "节奏稳定";
    els.tooltip.innerHTML = `
      <strong>${formatDate(item.date)} ${kind} ${time}</strong><br>
      睡眠 ${formatDuration(item.duration)}<br>
      ${escapeHtml(reasons)}
      ${item.note ? `<br>${escapeHtml(item.note)}` : ""}
    `;
    els.tooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const wrap = els.chart.parentElement.getBoundingClientRect();
    const left = Math.min(event.clientX - wrap.left + 14, wrap.width - 284);
    const top = Math.max(10, event.clientY - wrap.top - 24);
    els.tooltip.style.left = `${Math.max(10, left)}px`;
    els.tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    els.tooltip.hidden = true;
  }

  function renderAnomalies(analysis) {
    const anomalies = analysis.items.filter((item) => item.anomalyReasons.length).reverse();
    if (!anomalies.length) {
      els.anomalyList.innerHTML = '<p class="muted">暂无明显波动。</p>';
      return;
    }

    els.anomalyList.innerHTML = anomalies
      .map(
        (item) => `
          <article class="anomaly-item">
            <p class="item-title">${formatDate(item.date)}</p>
            <p class="item-meta">入睡 ${item.bedTime} · 起床 ${item.wakeTime} · ${formatDuration(item.duration)}</p>
            <div class="reason-list">
              ${item.anomalyReasons.map((reason) => `<span class="reason-pill">${escapeHtml(reason)}</span>`).join("")}
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
    render();
  }

  function clearAll() {
    if (!state.entries.length) return;
    if (!confirm("清空所有记录？")) return;
    state.entries = [];
    persistEntries();
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

  async function signOutCloud() {
    if (!syncState.auth) return;
    await syncState.firebase.auth.signOut(syncState.auth);
    syncState.ready = false;
    syncState.user = null;
    renderCloudUi();
  }

  async function loadCloudData() {
    if (!syncState.ready || syncState.loading) return;
    syncState.loading = true;
    setCloudUi("checking", "正在读取云端记录...");
    try {
      const { collection, doc, getDoc, getDocs } = syncState.firebase.firestore;
      const settingsRef = doc(syncState.db, "users", syncState.user.uid, "profile", "settings");
      const entriesRef = collection(syncState.db, "users", syncState.user.uid, "entries");
      const [settingsSnapshot, entriesSnapshot] = await Promise.all([getDoc(settingsRef), getDocs(entriesRef)]);
      const cloudSettings = settingsSnapshot.exists() ? settingsSnapshot.data() : null;
      const cloudEntries = entriesSnapshot.docs.map((entryDoc) => ({ id: entryDoc.id, ...entryDoc.data() }));

      if (cloudSettings) {
        state.settings = sanitizeSettings(cloudSettings);
      }
      state.entries = mergeEntries(state.entries, cloudEntries);
      sortEntries();
      persistLocalOnly();
      hydrateForms();
      render();
      syncState.loading = false;
      await syncCloudFromLocal();
      setCloudUi("synced", `已同步：${syncState.user.displayName || syncState.user.email || "Google 账号"}`);
    } catch (error) {
      console.error(error);
      setCloudUi("error", "读取云端记录失败，请检查 Firestore 是否已开启并配置规则。");
    } finally {
      syncState.loading = false;
    }
  }

  async function syncCloudFromLocal() {
    if (!syncState.ready || !syncState.firebase || syncState.loading) return;
    clearTimeout(syncState.pendingTimer);
    setCloudUi("checking", "正在同步到云端...");
    try {
      const { collection, doc, getDocs, setDoc, writeBatch } = syncState.firebase.firestore;
      const settingsRef = doc(syncState.db, "users", syncState.user.uid, "profile", "settings");
      const entriesRef = collection(syncState.db, "users", syncState.user.uid, "entries");
      const snapshot = await getDocs(entriesRef);
      const batch = writeBatch(syncState.db);
      const localIds = new Set(state.entries.map((entry) => entry.id));

      snapshot.docs.forEach((entryDoc) => {
        if (!localIds.has(entryDoc.id)) {
          batch.delete(entryDoc.ref);
        }
      });

      state.entries.forEach((entry) => {
        batch.set(doc(entriesRef, entry.id), normalizeEntryForSave(entry), { merge: true });
      });

      await Promise.all([setDoc(settingsRef, sanitizeSettings(state.settings), { merge: true }), batch.commit()]);
      setCloudUi("synced", "云端已同步。");
    } catch (error) {
      console.error(error);
      setCloudUi("error", "同步失败，请稍后重试。");
    }
  }

  function scheduleCloudSave() {
    if (!syncState.ready) return;
    clearTimeout(syncState.pendingTimer);
    syncState.pendingTimer = setTimeout(syncCloudFromLocal, 650);
    setCloudUi("checking", "等待同步...");
  }

  function renderCloudUi() {
    if (!syncState.configured) {
      setCloudUi("local", "未配置 Firebase，当前使用本地保存。");
      return;
    }
    if (!syncState.user) {
      setCloudUi("local", "登录后可在不同设备同步记录。");
      els.signInBtn.hidden = false;
      els.signOutBtn.hidden = true;
      els.syncNowBtn.hidden = true;
      return;
    }
    setCloudUi("synced", `已登录：${syncState.user.displayName || syncState.user.email || "Google 账号"}`);
    els.signInBtn.hidden = true;
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
    if (!syncState.configured) {
      els.signInBtn.hidden = true;
      els.signOutBtn.hidden = true;
      els.syncNowBtn.hidden = true;
      return;
    }
    if (status !== "local" || syncState.configured) {
      els.signInBtn.hidden = syncState.ready;
      els.signOutBtn.hidden = !syncState.ready;
      els.syncNowBtn.hidden = !syncState.ready;
    }
    window.lucide && window.lucide.createIcons();
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

  function analyzeEntries() {
    const threshold = state.settings.driftThreshold;
    const targetBed = normalizeNightTime(state.settings.targetBed, "bed");
    const targetWake = normalizeNightTime(state.settings.targetWake, "wake");

    const items = state.entries.map((entry, index, entries) => {
      const bedNorm = normalizeNightTime(entry.bedTime, "bed");
      const wakeNorm = normalizeNightTime(entry.wakeTime, "wake");
      const duration = wakeNorm >= bedNorm ? wakeNorm - bedNorm : wakeNorm + 24 * 60 - bedNorm;
      const previous = entries[index - 1];
      const targetReasons = [];
      const driftReasons = [];

      if (bedNorm - targetBed > threshold) targetReasons.push(`晚睡 ${formatDelta(bedNorm - targetBed)}`);
      if (wakeNorm - targetWake > threshold) targetReasons.push(`晚起 ${formatDelta(wakeNorm - targetWake)}`);
      if (duration < 6 * 60) targetReasons.push("睡眠不足 6 小时");

      if (previous) {
        const previousBed = normalizeNightTime(previous.bedTime, "bed");
        const previousWake = normalizeNightTime(previous.wakeTime, "wake");
        if (Math.abs(bedNorm - previousBed) > threshold) {
          driftReasons.push(`入睡波动 ${formatDelta(Math.abs(bedNorm - previousBed))}`);
        }
        if (Math.abs(wakeNorm - previousWake) > threshold) {
          driftReasons.push(`起床波动 ${formatDelta(Math.abs(wakeNorm - previousWake))}`);
        }
      }

      return {
        ...entry,
        tags: entry.tags || [],
        bedNorm,
        wakeNorm,
        duration,
        targetReasons,
        driftReasons,
        anomalyReasons: [...targetReasons, ...driftReasons],
        stable: targetReasons.length === 0,
      };
    });

    return { items };
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
    const header = ["日期", "入睡时间", "起床时间", "睡眠时长", "影响因素", "备注"];
    const rows = analyzeEntries().items.map((item) => [
      item.date,
      item.bedTime,
      item.wakeTime,
      formatDuration(item.duration),
      item.tags.join("；"),
      item.note || "",
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    download(`sleep-rhythm-${todayString()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  function exportJson() {
    const payload = {
      version: 1,
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
        state.entries = payload.entries.filter(isValidEntry);
        state.settings = { ...defaultSettings, ...(payload.settings || {}) };
        sortEntries();
        persistEntries();
        persistSettings();
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
      return Array.isArray(entries) ? entries.filter(isValidEntry).sort(byDateValue) : [];
    } catch {
      return [];
    }
  }

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      const isOldDefault =
        stored.targetBed === legacyDefaultSettings.targetBed && stored.targetWake === legacyDefaultSettings.targetWake;
      if (isOldDefault) {
        return { ...defaultSettings, driftThreshold: stored.driftThreshold || defaultSettings.driftThreshold };
      }
      return { ...defaultSettings, ...stored };
    } catch {
      return { ...defaultSettings };
    }
  }

  function isValidEntry(entry) {
    return entry && entry.id && isDate(entry.date) && isTime(entry.bedTime) && isTime(entry.wakeTime);
  }

  function persistEntries() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    scheduleCloudSave();
  }

  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    scheduleCloudSave();
  }

  function persistLocalOnly() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function mergeEntries(localEntries, cloudEntries) {
    const byDate = new Map();
    [...localEntries, ...cloudEntries].filter(isValidEntry).forEach((entry) => {
      const normalized = normalizeEntryForSave(entry);
      const current = byDate.get(normalized.date);
      if (!current || new Date(normalized.updatedAt || 0) >= new Date(current.updatedAt || 0)) {
        byDate.set(normalized.date, normalized);
      }
    });
    return Array.from(byDate.values()).sort(byDateValue);
  }

  function sanitizeSettings(settings) {
    return {
      targetBed: isTime(settings.targetBed) ? settings.targetBed : defaultSettings.targetBed,
      targetWake: isTime(settings.targetWake) ? settings.targetWake : defaultSettings.targetWake,
      driftThreshold: Number(settings.driftThreshold) || defaultSettings.driftThreshold,
    };
  }

  function normalizeEntryForSave(entry) {
    return {
      id: entry.id,
      date: entry.date,
      bedTime: entry.bedTime,
      wakeTime: entry.wakeTime,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => tags.includes(tag)) : [],
      note: entry.note || "",
      updatedAt: entry.updatedAt || new Date().toISOString(),
    };
  }

  function sortEntries() {
    state.entries.sort(byDateValue);
  }

  function byDateValue(a, b) {
    return a.date.localeCompare(b.date);
  }

  function normalizeNightTime(value, kind) {
    const minutes = timeToMinutes(value);
    if (kind === "bed") return minutes < 12 * 60 ? minutes + 24 * 60 : minutes;
    return minutes < 18 * 60 ? minutes + 24 * 60 : minutes;
  }

  function getChartRange(items) {
    const values = items.flatMap((item) => [item.bedNorm, item.wakeNorm]);
    const targetValues = [
      normalizeNightTime(state.settings.targetBed, "bed"),
      normalizeNightTime(state.settings.targetWake, "wake"),
    ];
    const defaultMin = 22 * 60;
    const defaultMax = 33 * 60;
    const rawMin = Math.min(defaultMin, ...values, ...targetValues);
    const rawMax = Math.max(defaultMax, ...values, ...targetValues);
    const min = Math.max(20 * 60, Math.floor(rawMin / 60) * 60);
    const max = Math.min(36 * 60, Math.ceil(rawMax / 60) * 60);
    return { min, max };
  }

  function makeHourlyTicks(min, max) {
    const ticks = [];
    for (let tick = min; tick <= max; tick += 60) {
      ticks.push(tick);
    }
    return ticks;
  }

  function timeToMinutes(value) {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function makePath(points) {
    return points.map(([x, y], index) => `${index ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
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

  function isDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function isTime(value) {
    return /^\d{2}:\d{2}$/.test(value);
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
