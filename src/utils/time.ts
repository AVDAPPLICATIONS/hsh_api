/**
 * Returns a Date object adjusted to Indian Standard Time (IST, UTC+5:30).
 */
export function getCurrentIST(): Date {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + istOffset);
}

/**
 * Returns the current minute of the day in Indian Standard Time (0 to 1439).
 */
export function getISTMinutes(): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.format(now).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

/**
 * Returns the current date in YYYY-MM-DD format in Indian Standard Time.
 */
export function getISTDateString(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(now);
}
