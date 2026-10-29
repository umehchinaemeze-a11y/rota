import {
  verifyWebhookSignature,
  BillingEventProcessor,
  globalBillingProcessor,
  type BillingEvent,
  type ProcessEventResult,
} from "../../../../lib/billing.ts";

// Shared in-memory billing processor instance for runtime state
const defaultProcessor = globalBillingProcessor;

/**
 * Pure testable webhook handler with dependency injection.
 */
export async function handleBillingWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
  processor: BillingEventProcessor = defaultProcessor,
  currentTime?: number
): Promise<{ status: number; body: Record<string, any> }> {
  if (!secret || secret.trim().length === 0) {
    return {
      status: 503,
      body: {
        error: "Billing webhook service unconfigured.",
        message: "STRIPE_WEBHOOK_SECRET is not configured in environment variables.",
      },
    };
  }

  if (!rawBody || rawBody.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Request body cannot be empty.",
      },
    };
  }

  const verification = verifyWebhookSignature(
    rawBody,
    signatureHeader,
    secret,
    300,
    currentTime
  );

  if (!verification.valid) {
    return {
      status: 400,
      body: {
        error: "Invalid Webhook Signature",
        reason: verification.reason || "Signature verification failed.",
      },
    };
  }

  let event: BillingEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: {
        error: "Invalid JSON",
        message: "Request body could not be parsed as JSON.",
      },
    };
  }

  const result: ProcessEventResult = await processor.processEvent(event);

  if (result.status === "failed") {
    return {
      status: 422,
      body: {
        error: "Unprocessable Event",
        message: result.message,
      },
    };
  }

  return {
    status: 200,
    body: {
      received: true,
      eventId: result.eventId,
      eventType: result.eventType,
      outcome: result.status,
      message: result.message,
    },
  };
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get("stripe-signature");
    const secret = process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET;

    const { status, body } = await handleBillingWebhook(
      rawBody,
      signatureHeader,
      secret,
      defaultProcessor
    );

    return Response.json(body, { status });
  } catch (error: any) {
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred during webhook processing.",
      },
      { status: 500 }
    );
  }
}
