/**
 * Returns a Date object adjusted to Indian Standard Time (IST, UTC+5:30).
 */
export function getCurrentIST(): Date {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + istOffset);
}
