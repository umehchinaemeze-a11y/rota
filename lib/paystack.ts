/**
 * Paystack Payment Gateway Integration Client & Offline Mock
 *
 * Implements:
 * 1. Strongly typed Paystack API v1 request/response interfaces for NGN transactions.
 * 2. Provider client interface (PaystackClientInterface).
 * 3. Offline mock client (MockPaystackClient) for zero-network testing.
 * 4. Production client skeleton (PaystackClient) with fail-closed safety.
 * 5. Strict integer kobo enforcement and zero external packages.
 */

export interface PaystackAuthorization {
  authorization_code: string;
  card_type: string;
  last4: string;
  exp_month: string;
  exp_year: string;
  bin: string;
  bank: string;
  channel: string;
  signature: string;
  reusable: boolean;
  country_code: string;
  account_name?: string | null;
}

export interface PaystackCustomer {
  id?: number;
  customer_code: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
}

export interface PaystackInitializeParams {
  email: string;
  amountKobo: number; // Integer kobo
  currency: "NGN";
  reference: string;
  callbackUrl: string;
  channels?: string[];
  metadata: {
    workspace_id: string | number;
    user_id: string | number;
    plan_id: string;
    seats: number;
    consent_recurring?: boolean;
    [key: string]: any;
  };
}

export interface PaystackPlanConfig {
  tier: "free" | "starter" | "pro" | "enterprise";
  planId: string;
  displayName: string;
  maxSeats: number;
  monthlyNgn: number;
  monthlyKobo: number; // Integer kobo
}

export const PAYSTACK_PLANS: Record<string, PaystackPlanConfig> = {
  free: {
    tier: "free",
    planId: "free",
    displayName: "Free Plan",
    maxSeats: 5,
    monthlyNgn: 0,
    monthlyKobo: 0,
  },
  starter: {
    tier: "starter",
    planId: "starter",
    displayName: "Starter Plan",
    maxSeats: 15,
    monthlyNgn: 15000,
    monthlyKobo: 1500000,
  },
  pro: {
    tier: "pro",
    planId: "pro",
    displayName: "Professional Plan",
    maxSeats: 50,
    monthlyNgn: 45000,
    monthlyKobo: 4500000,
  },
  enterprise: {
    tier: "enterprise",
    planId: "enterprise",
    displayName: "Enterprise Plan",
    maxSeats: 500,
    monthlyNgn: 150000,
    monthlyKobo: 15000000,
  },
};

export function getPaystackPlan(planId: string | null | undefined): PaystackPlanConfig {
  if (!planId) return PAYSTACK_PLANS.free;
  const key = planId.toLowerCase().replace("plan_", "").trim();
  return PAYSTACK_PLANS[key] || PAYSTACK_PLANS.free;
}

export interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

export interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    status: "success" | "failed" | "abandoned" | "pending";
    reference: string;
    amount: number; // in kobo
    currency: "NGN";
    gateway_response?: string;
    paid_at?: string;
    created_at: string;
    channel?: string;
    metadata: Record<string, any>;
    customer: PaystackCustomer;
    authorization: PaystackAuthorization;
  };
}

export interface PaystackChargeAuthorizationParams {
  authorizationCode: string;
  email: string;
  amountKobo: number; // Integer kobo
  currency: "NGN";
  reference: string;
  metadata?: Record<string, any>;
}

export interface PaystackChargeAuthorizationResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    status: "success" | "failed" | "pending";
    reference: string;
    amount: number; // in kobo
    currency: "NGN";
    gateway_response?: string;
    paid_at?: string;
    channel?: string;
    metadata?: Record<string, any>;
    customer?: PaystackCustomer;
    authorization?: PaystackAuthorization;
  };
}

export interface PaystackClientInterface {
  initializeTransaction(params: PaystackInitializeParams): Promise<PaystackInitializeResponse>;
  verifyTransaction(reference: string): Promise<PaystackVerifyResponse | null>;
  chargeAuthorization(params: PaystackChargeAuthorizationParams): Promise<PaystackChargeAuthorizationResponse>;
}

/**
 * In-memory Mock Paystack Client for offline unit testing.
 * Guarantees zero external network or database calls.
 */
export class MockPaystackClient implements PaystackClientInterface {
  private transactions = new Map<string, PaystackVerifyResponse["data"]>();
  public initializeCalls: PaystackInitializeParams[] = [];
  public verifyCalls: string[] = [];
  public chargeCalls: PaystackChargeAuthorizationParams[] = [];

  // Configurable simulation hooks for failure & timeout scenarios
  public simulateTimeoutOnInitialize = false;
  public simulateTimeoutOnVerify = false;
  public simulateTimeoutOnCharge = false;
  public simulateFailureOnCharge = false;
  public simulateNonReusableAuthorization = false;

  constructor(initialTransactions?: PaystackVerifyResponse["data"][]) {
    if (initialTransactions) {
      for (const t of initialTransactions) {
        this.transactions.set(t.reference, { ...t });
      }
    }
  }

  /**
   * Helper to seed a simulated transaction into the mock store.
   */
  seedTransaction(tx: PaystackVerifyResponse["data"]): void {
    this.transactions.set(tx.reference, { ...tx });
  }

  async initializeTransaction(params: PaystackInitializeParams): Promise<PaystackInitializeResponse> {
    this.initializeCalls.push({ ...params });

    if (this.simulateTimeoutOnInitialize) {
      throw new Error("Paystack gateway timeout during transaction initialization (simulated).");
    }

    if (!Number.isInteger(params.amountKobo) || params.amountKobo <= 0) {
      throw new RangeError(`Amount must be a positive integer in kobo. Received: ${params.amountKobo}`);
    }

    if (params.currency !== "NGN") {
      throw new Error(`Unsupported currency: ${params.currency}. Expected NGN.`);
    }

    const reference = params.reference || `pstk_ref_${Math.random().toString(36).substring(2, 12)}`;
    const accessCode = `acc_${Math.random().toString(36).substring(2, 10)}`;

    // Create corresponding pending transaction in mock store
    const authCode = `AUTH_${Math.random().toString(36).substring(2, 12)}`;
    const mockTxData: PaystackVerifyResponse["data"] = {
      id: Math.floor(Math.random() * 1_000_000) + 100_000,
      status: "success",
      reference,
      amount: params.amountKobo,
      currency: "NGN",
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      metadata: { ...params.metadata },
      customer: {
        id: 999,
        customer_code: `CUS_${Math.random().toString(36).substring(2, 10)}`,
        email: params.email,
      },
      authorization: {
        authorization_code: authCode,
        card_type: "visa",
        last4: "4081",
        exp_month: "12",
        exp_year: "2030",
        bin: "408185",
        bank: "Test Bank Nigeria",
        channel: "card",
        signature: `SIG_${Math.random().toString(36).substring(2, 12)}`,
        reusable: !this.simulateNonReusableAuthorization,
        country_code: "NG",
      },
    };

    this.transactions.set(reference, mockTxData);

    return {
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: `https://checkout.paystack.com/${accessCode}`,
        access_code: accessCode,
        reference,
      },
    };
  }

  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse | null> {
    this.verifyCalls.push(reference);

    if (this.simulateTimeoutOnVerify) {
      throw new Error("Paystack gateway network error during transaction verification (simulated).");
    }

    const tx = this.transactions.get(reference);
    if (!tx) {
      return null;
    }

    return {
      status: true,
      message: "Verification successful",
      data: { ...tx },
    };
  }

  async chargeAuthorization(
    params: PaystackChargeAuthorizationParams
  ): Promise<PaystackChargeAuthorizationResponse> {
    this.chargeCalls.push({ ...params });

    if (this.simulateTimeoutOnCharge) {
      throw new Error("Paystack network timeout during off-session authorization charge (simulated).");
    }

    if (!Number.isInteger(params.amountKobo) || params.amountKobo <= 0) {
      throw new RangeError(`Amount must be a positive integer in kobo. Received: ${params.amountKobo}`);
    }

    if (params.currency !== "NGN") {
      throw new Error(`Unsupported currency: ${params.currency}. Expected NGN.`);
    }

    if (!params.authorizationCode || params.authorizationCode.trim().length === 0) {
      throw new Error("Missing authorization code for off-session charge.");
    }

    if (this.simulateFailureOnCharge) {
      const failedData: PaystackChargeAuthorizationResponse["data"] = {
        id: Math.floor(Math.random() * 1_000_000) + 100_000,
        status: "failed",
        reference: params.reference,
        amount: params.amountKobo,
        currency: "NGN",
        gateway_response: "Insufficient funds in customer card account",
        metadata: { ...params.metadata },
      };
      return {
        status: false,
        message: "Charge attempt failed",
        data: failedData,
      };
    }

    const successData: PaystackChargeAuthorizationResponse["data"] = {
      id: Math.floor(Math.random() * 1_000_000) + 100_000,
      status: "success",
      reference: params.reference,
      amount: params.amountKobo,
      currency: "NGN",
      gateway_response: "Approved",
      paid_at: new Date().toISOString(),
      metadata: { ...params.metadata },
      customer: {
        customer_code: `CUS_${Math.random().toString(36).substring(2, 10)}`,
        email: params.email,
      },
      authorization: {
        authorization_code: params.authorizationCode,
        card_type: "visa",
        last4: "4081",
        exp_month: "12",
        exp_year: "2030",
        bin: "408185",
        bank: "Test Bank Nigeria",
        channel: "card",
        signature: `SIG_${Math.random().toString(36).substring(2, 12)}`,
        reusable: true,
        country_code: "NG",
      },
    };

    // Also record in internal transactions store so verification can find it
    this.transactions.set(params.reference, {
      ...successData,
      created_at: new Date().toISOString(),
      customer: successData.customer!,
      authorization: successData.authorization!,
      metadata: successData.metadata || {},
    });

    return {
      status: true,
      message: "Charge attempted successfully",
      data: successData,
    };
  }
}

/**
 * Standard Paystack API Client using native fetch.
 * In development or offline mode without PAYSTACK_SECRET_KEY, cleanly falls back
 * to MockPaystackClient to guarantee zero unauthorized external network requests.
 */
export class PaystackClient implements PaystackClientInterface {
  private secretKey?: string;
  private baseUrl: string;

  constructor(secretKey?: string, baseUrl: string = "https://api.paystack.co") {
    this.secretKey = secretKey || process.env.PAYSTACK_SECRET_KEY;
    this.baseUrl = baseUrl;
  }

  /**
   * Resolves whether to use MockPaystackClient or fail closed.
   * STRICT SAFETY GUARANTEE: In production or durable database environments,
   * missing Paystack credentials must NEVER silently produce mock payment success.
   */
  private getMockFallbackOrThrow(): MockPaystackClient | null {
    if (this.secretKey && this.secretKey.trim().length > 0) {
      return null; // Configured, execute real gateway call
    }

    const isProduction =
      process.env.NODE_ENV === "production" ||
      process.env.BILLING_ENVIRONMENT === "production" ||
      process.env.BILLING_STORAGE === "database";

    if (isProduction) {
      throw new Error(
        "Paystack credentials are required (PAYSTACK_SECRET_KEY is missing or unconfigured). " +
        "Silently falling back to MockPaystackClient in production or database environments is strictly prohibited."
      );
    }

    // In local development or unit test mode without credentials, use offline mock
    return new MockPaystackClient();
  }

  async initializeTransaction(params: PaystackInitializeParams): Promise<PaystackInitializeResponse> {
    const mock = this.getMockFallbackOrThrow();
    if (mock) {
      return mock.initializeTransaction(params);
    }

    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: params.email,
        amount: params.amountKobo,
        currency: params.currency,
        reference: params.reference,
        callback_url: params.callbackUrl,
        channels: params.channels || ["card"],
        metadata: params.metadata,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Paystack initialize error: ${err.message || res.statusText}`);
    }

    return (await res.json()) as PaystackInitializeResponse;
  }

  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse | null> {
    const mock = this.getMockFallbackOrThrow();
    if (mock) {
      return mock.verifyTransaction(reference);
    }

    const res = await fetch(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Paystack verify error: ${err.message || res.statusText}`);
    }

    return (await res.json()) as PaystackVerifyResponse;
  }

  async chargeAuthorization(
    params: PaystackChargeAuthorizationParams
  ): Promise<PaystackChargeAuthorizationResponse> {
    const mock = this.getMockFallbackOrThrow();
    if (mock) {
      return mock.chargeAuthorization(params);
    }

    const res = await fetch(`${this.baseUrl}/transaction/charge_authorization`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        authorization_code: params.authorizationCode,
        email: params.email,
        amount: params.amountKobo,
        currency: params.currency,
        reference: params.reference,
        metadata: params.metadata,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Paystack charge_authorization error: ${err.message || res.statusText}`);
    }

    return (await res.json()) as PaystackChargeAuthorizationResponse;
  }
}

export const defaultPaystackClient = new PaystackClient();
