export const sortTimes = (times: string[]): string[] => {
  return [...times].sort((a, b) => a.localeCompare(b));
};
