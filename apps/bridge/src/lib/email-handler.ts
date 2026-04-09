import PostalMime from "postal-mime";
import type { Env, TunnelRow } from "../types.js";

/**
 * Handles incoming emails to {domain}@flamecast.app.
 *
 * Parses the email, resolves the target tunnel, and enqueues
 * a message to the linked Flamecast instance so it spawns a
 * new session with the email content as the initial prompt.
 */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const to = message.to;
  const domain = extractDomain(to);

  if (!domain) {
    message.setReject(`Invalid recipient: ${to}`);
    return;
  }

  // Verify tunnel exists in D1
  const tunnel = await env.DB.prepare("SELECT * FROM tunnels WHERE name = ?")
    .bind(domain)
    .first<TunnelRow>();

  if (!tunnel) {
    message.setReject(`No linked Flamecast instance for "${domain}"`);
    return;
  }

  // Parse email content
  const rawEmail = await streamToArrayBuffer(message.raw);
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const subject = parsed.subject ?? "(no subject)";
  const body = parsed.text ?? parsed.html ?? "";
  const from = parsed.from?.address ?? message.from;
  const fromName = parsed.from?.name ?? "";

  // Build a prompt that gives the agent full context about the email
  const prompt = formatEmailPrompt({ from, fromName, subject, body });

  // Enqueue to the linked Flamecast instance's message queue
  const targetUrl = `https://${domain}.flamecast.app/api/message-queue`;

  console.log(`Enqueuing email from ${from} to ${targetUrl} with subject "${subject}", body "${body}", and prompt "${prompt}"`);

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: prompt,
      // null agentTemplateId = use the instance's default agent
      agentTemplateId: null,
      runtime: "",
      agent: "",
      directory: null,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown error");
    console.error(`Failed to enqueue email to ${targetUrl}: ${response.status} ${errorBody}`);
    message.setReject(`Flamecast instance unavailable (${response.status})`);
    return;
  }

  console.log(`Email from ${from} to ${domain}@flamecast.app enqueued successfully`);
}

/** Extract the domain portion from `{domain}@flamecast.app`. */
function extractDomain(to: string): string | null {
  const match = to.match(/^([a-z0-9][a-z0-9-]{1,30}[a-z0-9])@flamecast\.app$/i);
  return match ? match[1].toLowerCase() : null;
}

/** Read a ReadableStream into an ArrayBuffer. */
async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result.buffer;
}

function formatEmailPrompt(email: {
  from: string;
  fromName: string;
  subject: string;
  body: string;
}): string {
  const sender = email.fromName ? `${email.fromName} <${email.from}>` : email.from;

  return `You received an email. Process it and take appropriate action.

From: ${sender}
Subject: ${email.subject}

${email.body}`.trim();
}
