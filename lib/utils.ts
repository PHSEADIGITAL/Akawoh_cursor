export const PLATFORM_FEE_RATE = 0.015;
export const PLATFORM_FEE_CAP = 10_000;

export const toMoney = (value: number): number =>
  Number.parseFloat(value.toFixed(2));

export const calculatePlatformFee = (amount: number): number =>
  toMoney(Math.min(amount * PLATFORM_FEE_RATE, PLATFORM_FEE_CAP));

export const normalizePhone = (phone: string): string => {
  const trimmed = phone.replace(/\s+/g, "");
  if (trimmed.startsWith("+")) {
    return trimmed;
  }
  if (trimmed.startsWith("0")) {
    return `+234${trimmed.slice(1)}`;
  }
  if (trimmed.startsWith("234")) {
    return `+${trimmed}`;
  }
  return trimmed;
};

export const asNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
};
