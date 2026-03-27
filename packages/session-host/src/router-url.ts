export function buildForwardUrl(port: number, subPath: string, search: string): string {
  const url = new URL(`http://localhost:${port}${subPath}`);
  url.search = search;
  return url.toString();
}
