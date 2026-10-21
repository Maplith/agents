// The start of the calendar day an instant falls in, in a named time zone: the
// day a daily spending limit counts in. Standard library only (Intl).
const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(ms, timeZone) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function offsetAt(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** True when `timeZone` is a name this runtime knows. */
export function isTimeZone(timeZone) {
  try { formatter(timeZone); return true; } catch { return false; }
}

/** The instant (ms) the day containing `nowMs` began in `timeZone`. */
export function dayStart(nowMs, timeZone = 'UTC') {
  const w = wallClock(nowMs, timeZone);
  const naive = Date.UTC(w.y, w.mo - 1, w.d);
  return naive - offsetAt(naive - offsetAt(naive, timeZone), timeZone);
}
