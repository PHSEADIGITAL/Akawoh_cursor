import crypto from "node:crypto";

const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY ?? "";
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET ?? "";

type RecipientInput = {
  name: string;
  accountNumber: string;
  bankCode: string;
};

type TransferPayload = {
  amount: number;
  reason: string;
  recipientCode?: string;
  recipient?: RecipientInput;
};

type PaystackResponse<T> = {
  status?: boolean;
  message?: string;
  data?: T;
};

const hasPaystackKey = () => Boolean(PAYSTACK_SECRET_KEY);

const authorizedJsonRequest = async <T>(path: string, init?: RequestInit): Promise<PaystackResponse<T>> => {
  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      ...(init?.headers ?? {})
    }
  });
  const body = (await res.json()) as PaystackResponse<T>;
  if (!res.ok || !body.status) {
    throw new Error(body.message ?? "Paystack request failed.");
  }
  return body;
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

export const resolveBankAccount = async (
  bankCode: string,
  accountNumber: string
): Promise<{ accountName: string; bankCode: string; accountNumber: string }> => {
  if (!hasPaystackKey()) {
    return {
      accountName: "SIMULATED ACCOUNT NAME",
      bankCode,
      accountNumber
    };
  }

  const path = `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(
    bankCode
  )}`;
  const response = await authorizedJsonRequest<{ account_name?: string }>(path, {
    method: "GET"
  });

  const accountName = response.data?.account_name;
  if (!accountName) {
    throw new Error("Unable to verify bank account details.");
  }

  return {
    accountName,
    bankCode,
    accountNumber
  };
};

export const createTransferRecipient = async (
  recipient: RecipientInput
): Promise<{ recipientCode: string; accountName: string }> => {
  if (!hasPaystackKey()) {
    return {
      recipientCode: `sim_rcpt_${Date.now()}`,
      accountName: recipient.name
    };
  }

  const response = await authorizedJsonRequest<{
    recipient_code?: string;
    details?: { account_name?: string };
    name?: string;
  }>("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({
      type: "nuban",
      name: recipient.name,
      account_number: recipient.accountNumber,
      bank_code: recipient.bankCode,
      currency: "NGN"
    })
  });

  const recipientCode = response.data?.recipient_code;
  if (!recipientCode) {
    throw new Error("Could not create transfer recipient.");
  }

  return {
    recipientCode,
    accountName: response.data?.details?.account_name ?? response.data?.name ?? recipient.name
  };
};

export const transferWithPaystack = async (payload: TransferPayload): Promise<{
  reference: string;
  providerResponse: unknown;
}> => {
  // Fallback to simulation in local/dev if no secret key is configured.
  if (!hasPaystackKey()) {
    return {
      reference: `sim_${Date.now()}`,
      providerResponse: {
        status: true,
        simulated: true
      }
    };
  }

  let recipientCode = payload.recipientCode;
  if (!recipientCode) {
    if (!payload.recipient) {
      throw new Error("Transfer recipient details are required.");
    }
    const recipient = await createTransferRecipient(payload.recipient);
    recipientCode = recipient.recipientCode;
  }

  const body = await authorizedJsonRequest<{ reference?: string }>("/transfer", {
    method: "POST",
    body: JSON.stringify({
      source: "balance",
      reason: payload.reason,
      amount: Math.round(payload.amount * 100),
      recipient: recipientCode
    })
  });

  return {
    reference: body.data?.reference ?? `paystack_${Date.now()}`,
    providerResponse: body
  };
};
