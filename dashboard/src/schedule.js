'use strict';

const { getSetting } = require('./db');

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Day of week (0 = Sunday) and minutes since midnight in the given time zone.
function localClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    day: DAY_INDEX[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * True when "now" is inside the configured business hours.
 * When business hours are disabled the business is treated as always open.
 */
function isOpen(date = new Date(), hours = getSetting('businessHours')) {
  if (!hours || !hours.enabled) return true;
  let clock;
  try {
    clock = localClock(date, hours.timezone || 'UTC');
  } catch {
    clock = localClock(date, 'UTC');
  }
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  const days = Array.isArray(hours.days) ? hours.days : [];

  if (start === end) return days.includes(clock.day);
  if (start < end) return days.includes(clock.day) && clock.minutes >= start && clock.minutes < end;

  // Overnight window, for example 20:00 to 02:00.
  if (clock.minutes >= start) return days.includes(clock.day);
  const yesterday = (clock.day + 6) % 7;
  return clock.minutes < end && days.includes(yesterday);
}

module.exports = { isOpen, localClock };
