import { config } from "../config/index.js";
import { AppError } from "../errors/index.js";

const BASE = "https://api.paystack.co";
const TIMEOUT_MS = 20_000;

export type MomoNetwork = "mtn" | "vodafone" | "airteltigo";
const PROVIDER_CODE: Record<MomoNetwork, string> = { mtn: "mtn", vodafone: "vod", airteltigo: "atl" };

/** Ghana prefix -> network. Numbers are normalised first, so "+233 24..." and "024..." behave the same. */
const PREFIXES: Record<string, MomoNetwork> = {
  "024": "mtn", "025": "mtn", "053": "mtn", "054": "mtn", "055": "mtn", "059": "mtn",
  "020": "vodafone", "050": "vodafone",
  "026": "airteltigo", "027": "airteltigo", "056": "airteltigo", "057": "airteltigo",
};

/** "+233241234567" / "233241234567" / "241234567" -> "0241234567" */
export function toLocalGhanaNumber(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.startsWith("233")) return `0${d.slice(3)}`;
  if (d.startsWith("0")) return d;
  return `0${d}`;
}

/** Unknown prefixes fall back to MTN, as the old backend did. */
export function detectNetwork(phone: string): MomoNetwork {
  return PREFIXES[toLocalGhanaNumber(phone).slice(0, 3)] ?? "mtn";
}

export type PaystackVerification = {
  /** Paystack's own status: success | failed | abandoned | ongoing | pending | ... */
  status: string;
  reference: string;
  transactionId: string | null;
  /** pesewas */
  amountPesewas: bigint;
  currency: string;
  channel: string | null;
  paidAt: Date | null;
};

export type PaystackChargeResult = { status: string; displayText: string; reference: string };

export interface PaystackClient {
  chargeMobileMoney(input: {
    reference: string;
    amountPesewas: bigint;
    email: string;
    phone: string;
    network: MomoNetwork;
  }): Promise<PaystackChargeResult>;
  submitOtp(input: { reference: string; otp: string }): Promise<PaystackChargeResult>;
  verify(reference: string): Promise<PaystackVerification>;
}

async function call(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new AppError("Could not reach Paystack. Try again.", 502, "PAYSTACK_UNREACHABLE", { cause: String(err) });
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new AppError("Unexpected response from Paystack", 502, "PAYSTACK_BAD_RESPONSE");
  }
  return { ok: res.ok, json };
}

const httpClient: PaystackClient = {
  async chargeMobileMoney(i) {
    const { json } = await call("/charge", {
      method: "POST",
      body: JSON.stringify({
        amount: i.amountPesewas.toString(),
        currency: "GHS",
        email: i.email,
        reference: i.reference,
        mobile_money: { phone: i.phone, provider: PROVIDER_CODE[i.network] },
      }),
    });
    if (!json?.status || ["failed", "reversed"].includes(json?.data?.status)) {
      throw new AppError(json?.message || "Paystack charge failed", 402, "PAYSTACK_CHARGE_FAILED");
    }
    return {
      status: String(json.data?.status ?? "pending"),
      displayText: json.data?.display_text || "Check your phone to approve the payment",
      reference: i.reference,
    };
  },

  async submitOtp(i) {
    const { json } = await call("/charge/submit_otp", {
      method: "POST",
      body: JSON.stringify({ otp: i.otp, reference: i.reference }),
    });
    if (!json?.status) throw new AppError(json?.message || "OTP submission failed", 400, "PAYSTACK_OTP_FAILED");
    return {
      status: String(json.data?.status ?? "pending"),
      displayText: json.data?.display_text || "",
      reference: i.reference,
    };
  },

  async verify(reference) {
    const { json } = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d = json?.data;
    if (!json?.status || !d) {
      throw new AppError(json?.message || "Could not verify the transaction", 502, "PAYSTACK_VERIFY_FAILED");
    }
    return {
      status: String(d.status),
      reference: String(d.reference ?? reference),
      transactionId: d.id !== undefined ? String(d.id) : null,
      amountPesewas: BigInt(d.amount ?? 0),
      currency: String(d.currency ?? "GHS"),
      channel: d.channel ?? null,
      paidAt: d.paid_at ? new Date(d.paid_at) : null,
    };
  },
};

let client: PaystackClient = httpClient;
export const paystack = (): PaystackClient => client;
/** Tests swap the client for a fake so no real network call is made. */
export function setPaystackClient(next: PaystackClient | null) {
  client = next ?? httpClient;
}

/** Paystack channel -> our payment method (same mapping as the old backend). */
export function methodFromChannel(channel: string | null | undefined): "mobile_money" | "card" | null {
  if (channel === "mobile_money") return "mobile_money";
  if (channel === "card" || channel === "bank" || channel === "bank_transfer" || channel === "ussd" || channel === "qr") return "card";
  return null;
}
