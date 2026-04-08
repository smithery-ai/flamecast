const CF_API_BASE = "https://api.cloudflare.com/client/v4";

type CreateTunnelResponse = {
  result: {
    id: string;
    name: string;
    token: string;
  };
};

type CreateDnsRecordResponse = {
  result: {
    id: string;
  };
};

async function cfFetch<T>(
  path: string,
  apiToken: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${CF_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudflare API error: ${response.status} ${text}`);
  }

  return response.json() as Promise<T>;
}

type ListTunnelsResponse = {
  result: Array<{
    id: string;
    name: string;
    token: string;
  }>;
};

export async function createTunnel(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<{ tunnelId: string; tunnelToken: string }> {
  const tunnelSecret = btoa(crypto.getRandomValues(new Uint8Array(32)).toString());

  const response = await fetch(`${CF_API_BASE}/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      tunnel_secret: tunnelSecret,
      config_src: "cloudflare",
    }),
  });

  if (response.ok) {
    const data = (await response.json()) as CreateTunnelResponse;
    return { tunnelId: data.result.id, tunnelToken: data.result.token };
  }

  // Tunnel with this name already exists — look it up and get a fresh token
  if (response.status === 409) {
    const existing = await cfFetch<ListTunnelsResponse>(
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
      apiToken,
    );

    const tunnel = existing.result[0];
    if (!tunnel) {
      throw new Error(`Tunnel "${name}" conflict but could not find it`);
    }

    // Get a fresh token for the existing tunnel
    const tokenRes = await cfFetch<{ result: string }>(
      `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`,
      apiToken,
    );

    return { tunnelId: tunnel.id, tunnelToken: tokenRes.result };
  }

  const text = await response.text();
  throw new Error(`Cloudflare API error: ${response.status} ${text}`);
}

export async function configureTunnelIngress(
  accountId: string,
  apiToken: string,
  tunnelId: string,
  hostname: string,
  port: number,
): Promise<void> {
  await cfFetch(
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    apiToken,
    {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: `http://localhost:${port}` },
            { service: "http_status:404" },
          ],
        },
      }),
    },
  );
}

type ListDnsRecordsResponse = {
  result: Array<{ id: string }>;
};

export async function createDnsRecord(
  zoneId: string,
  apiToken: string,
  name: string,
  tunnelId: string,
): Promise<string> {
  const content = `${tunnelId}.cfargotunnel.com`;

  const response = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "CNAME",
      name,
      content,
      proxied: true,
    }),
  });

  if (response.ok) {
    const data = (await response.json()) as CreateDnsRecordResponse;
    return data.result.id;
  }

  // Record already exists — find it and update it
  if (response.status === 409) {
    const existing = await cfFetch<ListDnsRecordsResponse>(
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(`${name}.flamecast.app`)}`,
      apiToken,
    );

    const record = existing.result[0];
    if (!record) {
      throw new Error(`DNS record conflict for "${name}" but could not find it`);
    }

    // Update the existing record to point to the right tunnel
    await cfFetch(
      `/zones/${zoneId}/dns_records/${record.id}`,
      apiToken,
      {
        method: "PATCH",
        body: JSON.stringify({ content, proxied: true }),
      },
    );

    return record.id;
  }

  const text = await response.text();
  throw new Error(`Cloudflare API error: ${response.status} ${text}`);
}

export async function deleteTunnel(
  accountId: string,
  apiToken: string,
  tunnelId: string,
): Promise<void> {
  await cfFetch(
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}?cascade=true`,
    apiToken,
    { method: "DELETE" },
  );
}

export async function deleteDnsRecord(
  zoneId: string,
  apiToken: string,
  recordId: string,
): Promise<void> {
  await cfFetch(
    `/zones/${zoneId}/dns_records/${recordId}`,
    apiToken,
    { method: "DELETE" },
  );
}
