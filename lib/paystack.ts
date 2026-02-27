import crypto from "node:crypto";

const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY ?? "";
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET ?? "";

type TransferPayload = {
  amount: number;
  reason: string;
  recipient: {
    name: string;
    accountNumber: string;
    bankCode: string;
  };
};

export const verifyWebhookSignature = (rawBody: string, signature: string | null): boolean => {
  if (!PAYSTACK_WEBHOOK_SECRET || !signature) {
    return false;
  }
  const expected = crypto
    .createHmac("sha512", PAYSTACK_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
};

export const transferWithPaystack = async (payload: TransferPayload): Promise<{
  reference: string;
  providerResponse: unknown;
}> => {
  // Fallback to simulation in local/dev if no secret key is configured.
  if (!PAYSTACK_SECRET_KEY) {
    return {
      reference: `sim_${Date.now()}`,
      providerResponse: {
        status: true,
        simulated: true
      }
    };
  }

  const res = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
    },
    body: JSON.stringify({
      source: "balance",
      reason: payload.reason,
      amount: Math.round(payload.amount * 100),
      recipient: {
        name: payload.recipient.name,
        account_number: payload.recipient.accountNumber,
        bank_code: payload.recipient.bankCode
      }
    })
  });

  const body = (await res.json()) as { status?: boolean; data?: { reference?: string } };
  if (!res.ok || !body.status) {
    throw new Error("Paystack transfer failed.");
  }

  return {
    reference: body.data?.reference ?? `paystack_${Date.now()}`,
    providerResponse: body
  };
};
