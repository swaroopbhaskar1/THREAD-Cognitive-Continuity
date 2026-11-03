import { ReplitConnectors } from "@replit/connectors-sdk";
import { z } from "zod";

export type AlertPayload = {
  code: string; severity: string; state: "triggered" | "recovered";
  observed: number | null; threshold: number; observedAt: string; environment: string;
};
export type MailReceipt = { providerId: string };
export type AlertTransport = (id: string, payload: AlertPayload) => Promise<MailReceipt>;
export class DeliveryError extends Error {
  constructor(public code: string, public retryable: boolean) { super(code); }
}
export function mailConfigured() {
  return z.email().safeParse(process.env.THREAD_ALERT_FROM).success &&
    z.email().safeParse(process.env.THREAD_ALERT_TO).success;
}
async function submit(id: string, payload: AlertPayload) {
  if (!mailConfigured()) throw new DeliveryError("DESTINATION_UNCONFIGURED", false);
  if (process.env.NODE_ENV === "production" && process.env.THREAD_ALERT_FROM?.endsWith("@resend.dev")) {
    throw new DeliveryError("TEST_SENDER_NOT_FOR_PRODUCTION", false);
  }
  try {
    const response = await new ReplitConnectors().proxy("resend", "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `thread-ops/${id}` },
      body: JSON.stringify({
        from: process.env.THREAD_ALERT_FROM, to: [process.env.THREAD_ALERT_TO],
        subject: `[THREAD ${payload.environment}] ${payload.severity}: ${payload.code} (${payload.state})`,
        text: `THREAD operational notification. No learning content is included.\n${JSON.stringify(payload, null, 2)}\nDelivery ID: ${id}\nAn accepted API request is not proof of inbox delivery.`,
      }),
    });
    if (!response.ok) throw new DeliveryError(`EMAIL_HTTP_${response.status}`, response.status === 429 || response.status >= 500);
    const body = z.object({ id: z.string().min(1).max(200) }).safeParse(await response.json());
    if (!body.success) throw new DeliveryError("INVALID_EMAIL_ACKNOWLEDGMENT", false);
    return { providerId: body.data.id };
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    // Never serialize provider errors, email addresses, connector credentials or response bodies.
    throw new DeliveryError("EMAIL_TRANSPORT_INTERRUPTED", true);
  }
}
export const sendOperationalMail: AlertTransport = async (id, payload) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // SDK currently exposes no AbortSignal. This bounds our wait, not the remote
    // call's lifetime. Retry the same persisted payload/idempotency key; outcome
    // remains unknown after timeout. Do not claim transport cancellation.
    return await Promise.race([
      submit(id, payload),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryError("EMAIL_TIMEOUT_OUTCOME_UNKNOWN", true)), 5000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
};
