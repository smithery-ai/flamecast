function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function normalizeProto(value: string | null): "http" | "https" | null {
  if (!value) return null;
  const proto = value.split(",")[0]?.trim().replace(/:$/, "");
  return proto === "http" || proto === "https" ? proto : null;
}

function parseCfVisitorScheme(value: string | null): "http" | "https" | null {
  if (!value) return null;
  try {
    const parsed: { scheme?: string } = JSON.parse(value);
    return parsed.scheme === "http" || parsed.scheme === "https" ? parsed.scheme : null;
  } catch {
    return null;
  }
}

export function resolvePublicApiUrl(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = normalizeProto(request.headers.get("x-forwarded-proto"));
  const cfVisitorScheme = parseCfVisitorScheme(request.headers.get("cf-visitor"));
  const proto =
    forwardedProto ??
    cfVisitorScheme ??
    (isLoopbackHost(url.hostname) ? url.protocol.slice(0, -1) : "https");

  return `${proto}://${url.host}/api`;
}
