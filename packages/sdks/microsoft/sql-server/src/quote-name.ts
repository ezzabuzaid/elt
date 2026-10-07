// SQL Server's QUOTENAME: an identifier in brackets, any ] doubled.
export function quoteName(name: string): string {
  return `[${name.replaceAll(']', ']]')}]`;
}
