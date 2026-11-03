// Date/time values for ${date}, ${time} and ${timestamp} template placeholders.
// date and time follow the configured timezone so they match the daily windows
// in state.js; timestamp stays an unambiguous UTC ISO string.
export function getTemplateDateParts(timezone = 'UTC', now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now).map(p => [p.type, p.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    timestamp: now.toISOString()
  };
}

// HH:MM for the status table's next-issue column. An interval can run past
// midnight, so a time on another local day carries its date as well;
// otherwise "02:00" seen at 23:30 reads as earlier today.
export function formatNextIssueTime(timezone = 'UTC', instant, now = new Date()) {
  const next = getTemplateDateParts(timezone, instant);
  const time = next.time.slice(0, 5);
  return next.date === getTemplateDateParts(timezone, now).date ? time : `${next.date} ${time}`;
}
