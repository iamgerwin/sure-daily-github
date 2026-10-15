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
