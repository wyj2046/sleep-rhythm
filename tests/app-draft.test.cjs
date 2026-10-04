const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../trend-core.js");
const entryDetails = require("../entry-details.js");

const SETTINGS_KEY = "sleep-rhythm.settings.v1";
const ENTRY_KEY = "sleep-rhythm.entries.v1";
const target = (bed = "23:00", wake = "06:20") => ({
  targetBed: bed, targetWake: wake, driftThreshold: 30, targetHistoryVersion: 1,
  targetHistory: [{ effectiveFrom: "2026-08-31", targetBed: bed, targetWake: wake, driftThreshold: 30 }],
});
const record = (id, date, bedTime = "23:10", wakeTime = "06:25") => ({
  id, date, bedTime, wakeTime, note: "原始备注", tags: ["运动"],
  targetSnapshot: target().targetHistory[0], updatedAt: "2026-10-04T01:00:00.000Z",
});
const plain = (value) => JSON.parse(JSON.stringify(value));

// Runs the actual application functions with in-memory DOM/storage/Firestore.
// Initialization and rendering are replaced so these regressions never contact
// Firebase, launch authentication, or read any real browser storage.
function harness(entries = []) {
  const stored = new Map([[ENTRY_KEY, JSON.stringify(entries)], [SETTINGS_KEY, JSON.stringify(target())]]);
  const elements = new Map();
  const fixture = { tags: [], confirms: [], confirmResult: true, renders: 0, cloudEntries: entries, cloudSettings: target("22:45", "06:10") };
  fixture.writeBatch = () => {
    const operations = [];
    return {
      set(ref, data, options = {}) { operations.push({ type: "set", ref, data: plain(data), options }); },
      delete(ref) { operations.push({ type: "delete", ref }); },
      async commit() {
        for (const operation of operations) {
          const id = operation.ref.at(-1);
          if (operation.ref.at(-2) === "profile") {
            fixture.cloudSettings = operation.options.merge ? { ...fixture.cloudSettings, ...operation.data } : operation.data;
            continue;
          }
          const old = fixture.cloudEntries.find((entry) => entry.id === id);
          fixture.cloudEntries = fixture.cloudEntries.filter((entry) => entry.id !== id);
          if (operation.type === "set") fixture.cloudEntries.push(operation.options.merge ? { ...old, ...operation.data } : operation.data);
        }
      },
    };
  };
  function element(selector) {
    if (!elements.has(selector)) {
      const listeners = new Map();
      elements.set(selector, {
        value: "", checked: false, dataset: {}, textContent: "", innerHTML: "",
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
        dispatch(name, targetElement = this) { (listeners.get(name) || []).forEach((fn) => fn({ target: targetElement, preventDefault() {} })); },
        querySelector(child) { return element(`${selector} ${child}`); },
        querySelectorAll() { return []; },
        scrollIntoView() {}, focus() {}, setCustomValidity() {}, reportValidity() { return true; },
        checkValidity() { return true; }, setAttribute(name, value) { this[name] = String(value); },
        removeAttribute(name) { delete this[name]; },
        classList: { add() {}, remove() {}, toggle() {} },
      });
    }
    return elements.get(selector);
  }
  const context = {
    window: { location: { hash: "" }, SleepTrendCore: core, SleepEntryDetails: entryDetails, addEventListener() {}, crypto: { randomUUID: () => "generated-id" } },
    document: {
      querySelector: element,
      querySelectorAll: () => fixture.tags.map((value) => ({ value })),
      addEventListener() {},
    },
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    confirm(message) { fixture.confirms.push(message); return fixture.confirmResult; },
    alert(message) { throw new Error(`Unexpected alert: ${message}`); },
    console, Date, setTimeout: () => 1, clearTimeout() {}, __fixture: fixture,
  };
  let source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  assert.match(source, /^  init\(\);$/m, "test harness must disable startup");
  source = source.replace(/^  init\(\);$/m, "");
  source = source.replace(/\}\)\(\);\s*$/, `
    render = () => { __fixture.renders += 1; };
    renderTags = (selected = []) => { __fixture.tags = Array.from(selected); };
    renderTargetHistory = () => {};
    updateTrendSourceStatus = () => {};
    setCloudUi = () => {};
    syncState.ready = true;
    syncState.user = { uid: "isolated-test" };
    syncState.firebase = { firestore: {
      doc: (...parts) => parts, collection: (...parts) => parts,
      getDoc: async () => ({ exists: () => true, data: () => __fixture.cloudSettings }),
      getDocs: async () => ({ docs: __fixture.cloudEntries.map(entry => ({ id: entry.id, data: () => entry })) }),
      writeBatch: __fixture.writeBatch,
    } };
    globalThis.appTest = { els, state, cloudQueue, formDraftState, bindEvents, hydrateForms,
      saveEntry, saveSettings, resetEntryForm, editEntry, loadCloudData, normalizeEntryForSave, flushCloudQueue };
  })();`);
  vm.runInNewContext(source, context, { filename: "app.js" });
  const app = context.appTest;
  app.hydrateForms();
  app.bindEvents();
  return { ...app, fixture, stored, submit: { preventDefault() {} }, refresh: () => app.loadCloudData({ flushPending: false }) };
}

test("cloud hydration initializes pristine fields with downloaded settings", async () => {
  const h = harness();
  assert.equal(await h.refresh(), true);
  assert.equal(h.els.bedTime.value, "22:45");
  assert.equal(h.els.wakeTime.value, "06:10");
  assert.equal(h.els.targetBed.value, "22:45");
});

test("cloud refresh preserves an old record's identity, date and fields before saving", async () => {
  const old = record("old", "2026-09-18");
  const h = harness([old]);
  h.editEntry(h.state.entries[0]);
  assert.equal(await h.refresh(), true);
  assert.equal(h.els.editingId.value, "old");
  assert.equal(h.els.sleepDate.value, old.date);
  assert.equal(h.els.bedTime.value, old.bedTime);
  assert.equal(h.els.wakeTime.value, old.wakeTime);
  assert.equal(h.els.note.value, old.note);
  h.saveEntry(h.submit);
  assert.equal(h.state.entries.length, 1);
  assert.equal(h.state.entries[0].date, old.date);
  assert.equal(h.fixture.confirms.length, 0);
});

test("note input and tag changes each protect a new draft during cloud refresh", async () => {
  for (const eventName of ["input", "change"]) {
    const h = harness();
    h.els.sleepDate.value = "2026-10-03";
    h.els.note.value = "尚未保存的新备注";
    h.fixture.tags = ["失眠"];
    h.els.form.dispatch(eventName, eventName === "input" ? h.els.note : h.els.tagGrid);
    assert.equal(await h.refresh(), true);
    assert.equal(h.els.sleepDate.value, "2026-10-03");
    assert.equal(h.els.bedTime.value, "23:00");
    assert.equal(h.els.note.value, "尚未保存的新备注");
    assert.deepEqual(h.fixture.tags, ["失眠"]);
    assert.equal(h.els.targetBed.value, "22:45", "the untouched settings form still hydrates");
  }
});

test("unsaved settings survive cloud refresh while untouched entry defaults hydrate", async () => {
  const h = harness();
  h.els.targetBed.value = "22:30";
  h.els.driftThreshold.value = "45";
  h.els.driftValue.textContent = "45 分钟";
  h.els.settingsForm.dispatch("input", h.els.targetBed);
  assert.equal(await h.refresh(), true);
  assert.equal(h.els.targetBed.value, "22:30");
  assert.equal(h.els.driftThreshold.value, "45");
  assert.equal(h.els.driftValue.textContent, "45 分钟");
  assert.equal(h.els.bedTime.value, "22:45");
});

test("cancelling a same-date replacement leaves entries, queue, storage and draft intact", () => {
  const h = harness([record("existing", "2026-10-03")]);
  h.els.sleepDate.value = "2026-10-03";
  h.els.bedTime.value = "23:50";
  h.els.note.value = "替换草稿";
  h.els.form.dispatch("input");
  h.fixture.confirmResult = false;
  const before = JSON.stringify(h.state.entries);
  const storageBefore = Array.from(h.stored);
  h.saveEntry(h.submit);
  assert.equal(JSON.stringify(h.state.entries), before);
  assert.deepEqual(Array.from(h.stored), storageBefore);
  assert.equal(h.cloudQueue.operations.length, 0);
  assert.equal(h.els.note.value, "替换草稿");
  assert.equal(h.formDraftState.entryDirty, true);
  assert.match(h.fixture.confirms[0], /23:10 → 06:25/);
});

test("confirmed same-date replacement retains the existing id and clears the saved draft", () => {
  const h = harness([record("existing", "2026-10-03")]);
  h.els.sleepDate.value = "2026-10-03";
  h.els.bedTime.value = "23:50";
  h.els.form.dispatch("input");
  h.saveEntry(h.submit);
  assert.equal(h.state.entries.length, 1);
  assert.equal(h.state.entries[0].id, "existing");
  assert.equal(h.state.entries[0].bedTime, "23:50");
  assert.deepEqual(plain(h.cloudQueue.operations.map((op) => op.type)), ["upsert"]);
  assert.equal(h.fixture.confirms.length, 1, "successful save must not ask to discard the same draft");
  assert.equal(h.formDraftState.entryDirty, false);
});

test("moving an edit onto another date confirms before replacing its record", () => {
  const h = harness([record("edited", "2026-10-02"), record("destination", "2026-10-03")]);
  h.editEntry(h.state.entries.find((entry) => entry.id === "edited"));
  h.els.sleepDate.value = "2026-10-03";
  h.els.form.dispatch("change");
  h.fixture.confirmResult = false;
  h.saveEntry(h.submit);
  assert.equal(h.state.entries.length, 2);
  assert.equal(h.cloudQueue.operations.length, 0);
  h.fixture.confirmResult = true;
  h.saveEntry(h.submit);
  assert.equal(h.state.entries.length, 1);
  assert.equal(h.state.entries[0].id, "edited");
  assert.equal(h.state.entries[0].date, "2026-10-03");
  assert.deepEqual(plain(h.cloudQueue.operations.map((op) => [op.type, op.id || op.entry.id])), [["delete", "destination"], ["upsert", "edited"]]);
});

test("discarding a dirty draft to reset or switch records is cancellable", () => {
  const h = harness([record("existing", "2026-10-03")]);
  h.els.note.value = "保留我";
  h.els.form.dispatch("input");
  h.fixture.confirmResult = false;
  assert.equal(h.resetEntryForm(), false);
  assert.equal(h.editEntry(h.state.entries[0]), false);
  assert.equal(h.els.note.value, "保留我");
  assert.equal(h.els.editingId.value, "");
  assert.equal(h.formDraftState.entryDirty, true);
  h.fixture.confirmResult = true;
  assert.equal(h.editEntry(h.state.entries[0]), true);
  assert.equal(h.els.editingId.value, "existing");
  assert.equal(h.formDraftState.entryDirty, false);
});

test("saving settings preserves a dirty entry even if its time still equals the old target", () => {
  const h = harness();
  h.els.note.value = "已开始填写";
  h.els.form.dispatch("input", h.els.note);
  h.els.targetBed.value = "22:45";
  h.els.settingsForm.dispatch("input", h.els.targetBed);
  h.saveSettings(h.submit);
  assert.equal(h.els.bedTime.value, "23:00");
  assert.equal(h.els.note.value, "已开始填写");
  assert.equal(h.formDraftState.entryDirty, true);
  assert.equal(h.formDraftState.settingsDirty, false);
});

test("optional sleep details survive save, cloud normalization, download and editing", async () => {
  const h = harness();
  const details = { bedTimeKind: "bed", sleepOnsetTime: "23:35", finalWakeTime: "06:00", awakeMinutes: 0, morningFeeling: "tired" };
  h.els.sleepDate.value = "2026-10-03";
  h.els.bedTime.value = "23:10";
  h.els.wakeTime.value = "06:25";
  for (const [field, value] of Object.entries(details)) h.els[field].value = String(value);
  h.els.form.dispatch("input", h.els.awakeMinutes);
  h.saveEntry(h.submit);
  assert.equal(h.state.entries.length, 1);
  for (const [field, value] of Object.entries(details)) assert.equal(h.state.entries[0][field], value);
  const normalized = h.normalizeEntryForSave(h.state.entries[0]);
  for (const [field, value] of Object.entries(details)) assert.equal(normalized[field], value);
  const queued = h.cloudQueue.operations.find((operation) => operation.type === "upsert").entry;
  for (const [field, value] of Object.entries(details)) assert.equal(queued[field], value);

  // Clear pending writes so the download must reconstruct from the cloud snapshot.
  h.cloudQueue.operations.splice(0);
  h.fixture.cloudEntries = [plain(normalized)];
  h.state.entries = [];
  assert.equal(await h.refresh(), true);
  assert.equal(h.state.entries.length, 1);
  for (const [field, value] of Object.entries(details)) assert.equal(h.state.entries[0][field], value);
  h.editEntry(h.state.entries[0]);
  for (const [field, value] of Object.entries(details)) assert.equal(String(h.els[field].value), String(value));
  assert.equal(h.els.sleepDate.value, "2026-10-03");
});

test("cleared optional fields stay empty after uploading and reading the cloud record", async () => {
  const h = harness([{ ...record("existing", "2026-10-03"), bedTimeKind: "bed", sleepOnsetTime: "23:35", finalWakeTime: "06:00", awakeMinutes: 0, morningFeeling: "tired" }]);
  h.editEntry(h.state.entries[0]);
  const clearedFields = ["sleepOnsetTime", "finalWakeTime", "awakeMinutes", "morningFeeling"];
  for (const field of clearedFields) h.els[field].value = "";
  h.els.form.dispatch("input", h.els.awakeMinutes);
  h.saveEntry(h.submit);
  for (const field of clearedFields) assert.equal(h.state.entries[0][field], undefined);
  assert.equal(await h.flushCloudQueue(), true);
  assert.equal(h.cloudQueue.operations.length, 0);
  assert.equal(await h.refresh(), true);
  for (const field of clearedFields) assert.equal(h.state.entries[0][field], undefined, `${field} must not return from a stale cloud value`);
  h.editEntry(h.state.entries[0]);
  for (const field of clearedFields) assert.equal(h.els[field].value, "");
});
