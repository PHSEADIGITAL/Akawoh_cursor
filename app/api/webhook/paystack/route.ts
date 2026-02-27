import { NextRequest, NextResponse } from "next/server";
import { processDeposit } from "@/lib/mvp-service";
import { verifyWebhookSignature } from "@/lib/paystack";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ ok: false, message: "Invalid webhook signature." }, { status: 401 });
  }

  try {
    const event = JSON.parse(rawBody) as {
      event?: string;
      data?: {
        reference?: string;
        amount?: number;
        metadata?: {
          userId?: string;
        };
      };
    };

    if (event.event !== "charge.success") {
      return NextResponse.json({ ok: true, ignored: true });
    }

    const userId = event.data?.metadata?.userId;
    const amountKobo = event.data?.amount;
    if (!userId || !amountKobo) {
      return NextResponse.json({ ok: false, message: "Missing webhook payload fields." }, { status: 400 });
    }

    const result = await processDeposit({
      userId,
      amount: amountKobo / 100,
      referenceId: event.data?.reference ?? `webhook_${Date.now()}`
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Unexpected webhook error"
      },
      { status: 500 }
    );
  }
}
