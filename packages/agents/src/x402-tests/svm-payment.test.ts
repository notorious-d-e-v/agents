/**
 * Solana payments through `withX402` and `withX402Client` using the real
 * x402 resource server, client selector, and `@x402/svm` exact schemes. The
 * facilitator's HTTP API is stubbed, and so is SVM transaction construction,
 * which needs a Solana RPC.
 */
import { Client } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExactSvmScheme as ExactSvmClientScheme } from "@x402/svm/exact/client";
import { ExactSvmScheme as ExactSvmServerScheme } from "@x402/svm/exact/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withX402,
  withX402Client,
  type PaymentRequirements
} from "../mcp/client/x402";

const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RECIPIENT = "1nc1nerator11111111111111111111111111111111";
const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type FacilitatorCall = { path: string; body: Record<string, unknown> };

function stubFacilitator() {
  const calls: FacilitatorCall[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" }
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.split("/").pop() ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      switch (path) {
        case "supported":
          return json({
            kinds: [
              {
                x402Version: 2,
                scheme: "exact",
                network: SOLANA_DEVNET,
                extra: { feePayer: FEE_PAYER }
              }
            ]
          });
        case "verify":
          return json({ isValid: true, payer: PAYER });
        case "settle":
          return json({
            success: true,
            transaction: "5solanaTxSignature",
            network: SOLANA_DEVNET,
            payer: PAYER
          });
        default:
          return new Response("not found", { status: 404 });
      }
    })
  );
  return calls;
}

function createPaidSolanaTool() {
  const registerTool = vi.fn();
  const server = withX402({ registerTool } as unknown as McpServer, {
    network: "solana-devnet",
    recipient: RECIPIENT,
    facilitator: { url: "https://facilitator.test" },
    schemes: [{ network: "solana:*", server: new ExactSvmServerScheme() }]
  });
  server.paidTool("square", "Squares a number", 0.01, {}, {}, async () => ({
    content: [{ type: "text", text: "25" }]
  }));
  return registerTool.mock.calls[0][2] as (
    args: unknown,
    extra: unknown
  ) => Promise<Record<string, unknown> & { _meta?: Record<string, unknown> }>;
}

function createPayingClient(
  callTool: (params: { _meta?: Record<string, unknown> }) => Promise<unknown>,
  maxPaymentValue?: bigint
) {
  const scheme = new ExactSvmClientScheme({ address: PAYER } as never);
  const createPayload = vi
    .spyOn(scheme, "createPaymentPayload")
    .mockResolvedValue({
      x402Version: 2,
      payload: { transaction: "c2lnbmVkLXR4" }
    });
  const client = new Client({ name: "svm-payment-test", version: "1.0.0" });
  const mcpCallTool = vi
    .spyOn(client, "callTool")
    .mockImplementation(callTool as never);
  return {
    client: withX402Client(client, {
      schemes: [{ network: "solana:*", client: scheme }],
      maxPaymentValue
    }),
    createPayload,
    mcpCallTool
  };
}

describe("x402 on Solana", () => {
  let facilitator: FacilitatorCall[];

  beforeEach(() => {
    facilitator = stubFacilitator();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises a devnet USDC requirement with the facilitator fee payer", async () => {
    const paidTool = createPaidSolanaTool();
    const result = await paidTool({}, {});

    expect(result.isError).toBe(true);
    const challenge = result._meta?.["x402/error"] as {
      accepts: PaymentRequirements[];
    };
    expect(challenge.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: SOLANA_DEVNET,
        asset: DEVNET_USDC,
        amount: "10000",
        payTo: RECIPIENT,
        extra: expect.objectContaining({ feePayer: FEE_PAYER })
      })
    ]);
  });

  it("pays, runs, and settles a Solana-priced tool end to end", async () => {
    const paidTool = createPaidSolanaTool();
    const { client, createPayload, mcpCallTool } = createPayingClient(
      ({ _meta }) => paidTool({}, { _meta })
    );

    const result = await client.callTool(null, { name: "square" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "25" }]);
    expect(result._meta?.["x402/payment-response"]).toEqual({
      success: true,
      transaction: "5solanaTxSignature",
      network: SOLANA_DEVNET,
      payer: PAYER
    });
    expect(mcpCallTool).toHaveBeenCalledTimes(2);
    expect(createPayload).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ network: SOLANA_DEVNET, payTo: RECIPIENT }),
      expect.anything()
    );
    const settle = facilitator.find((call) => call.path === "settle");
    expect(settle?.body.paymentRequirements).toEqual(
      expect.objectContaining({ network: SOLANA_DEVNET, payTo: RECIPIENT })
    );
  });

  it("selects the Solana requirement when it is the only one it can sign", async () => {
    const evm: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" }
    };
    const svm: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET,
      amount: "10000",
      asset: DEVNET_USDC,
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { feePayer: FEE_PAYER }
    };
    let attempt = 0;
    const { client, createPayload } = createPayingClient(async () =>
      attempt++ === 0
        ? {
            isError: true,
            content: [],
            _meta: {
              "x402/error": {
                x402Version: 2,
                resource: { url: "x402://test", description: "Test" },
                accepts: [evm, svm]
              }
            }
          }
        : { content: [{ type: "text", text: "Paid" }] }
    );

    await client.callTool(null, { name: "test" });

    expect(createPayload).toHaveBeenCalledOnce();
    expect(createPayload.mock.calls[0][1]).toEqual(svm);
  });

  it("enforces maxPaymentValue before building a Solana transaction", async () => {
    const paidTool = createPaidSolanaTool();
    const { client, createPayload, mcpCallTool } = createPayingClient(
      ({ _meta }) => paidTool({}, { _meta }),
      9999n
    );

    const result = await client.callTool(null, { name: "square" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Payment exceeds client cap: 10000 > 9999" }
    ]);
    expect(createPayload).not.toHaveBeenCalled();
    expect(mcpCallTool).toHaveBeenCalledOnce();
    expect(facilitator.some((call) => call.path === "settle")).toBe(false);
  });
});
