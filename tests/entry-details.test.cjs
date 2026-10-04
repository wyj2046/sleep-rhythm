const test = require('node:test');
const assert = require('node:assert/strict');
const details = require('../entry-details.js');

test('legacy records retain unknown time meaning and missing wakefulness', () => {
  assert.deepEqual(details.normalize({ bedTime: '23:00', wakeTime: '06:20' }), {});
  assert.equal(details.bedtimeLabel({}), '就寝（原入睡）');
});

test('optional sleep information survives JSON normalization, including explicit zero', () => {
  const values = { bedTimeKind: 'bed', sleepOnsetTime: '00:20', finalWakeTime: '05:30', awakeMinutes: 0, morningFeeling: 'tired' };
  assert.deepEqual(details.normalize(JSON.parse(JSON.stringify(values))), values);
  assert.deepEqual(details.normalize({ awakeMinutes: '', morningFeeling: 'unknown', sleepOnsetTime: '25:00', bedTimeKind: 'made-up' }), {});
});

test('validates intervals across midnight without guessing sleep duration', () => {
  const record = { bedTime: '23:05', wakeTime: '06:08', bedTimeKind: 'bed', sleepOnsetTime: '00:20', finalWakeTime: '05:30', awakeMinutes: 25 };
  assert.equal(details.validate(record), null);
  assert.equal(details.validate({ ...record, finalWakeTime: '06:30' }).field, 'finalWakeTime');
  assert.equal(details.validate({ ...record, sleepOnsetTime: '22:30' }).field, 'sleepOnsetTime');
  assert.equal(details.validate({ ...record, awakeMinutes: 400 }).field, 'awakeMinutes');
  assert.equal(details.validate({ ...record, bedTimeKind: 'asleep' }).field, 'sleepOnsetTime');
});


test('accepts a recorded interval that continues past noon', () => {
  assert.equal(details.validate({ bedTime: '11:50', wakeTime: '15:00', sleepOnsetTime: '12:10', finalWakeTime: '14:30' }), null);
  assert.equal(details.validate({ bedTime: '11:50', wakeTime: '15:00', sleepOnsetTime: '11:40' }).field, 'sleepOnsetTime');
});
