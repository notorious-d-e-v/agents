import { Agent, callable, routeAgentRequest } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import {
  withX402,
  withX402Client,
  type X402Config,
  type PaymentRequirements
} from "agents/x402";
import { z } from "zod";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme as ExactSvmClientScheme } from "@x402/svm/exact/client";
import { ExactSvmScheme as ExactSvmServerScheme } from "@x402/svm/exact/server";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";

// --- MCP Server with paid tools ---

// "base-sepolia" (default) or "solana-devnet"
const NETWORK = process.env.MCP_NETWORK || "base-sepolia";

const X402_CONFIG: X402Config = {
  network: NETWORK,
  // An address on NETWORK. A Solana recipient must already hold a devnet
  // USDC token account, or verification fails.
  recipient: process.env.MCP_ADDRESS as string,
  facilitator: { url: "https://x402.org/facilitator" },
  schemes: [{ network: "solana:*", server: new ExactSvmServerScheme() }]
};

export class PayMCP extends McpAgent<Env> {
  server = withX402(
    new McpServer({ name: "PayMCP", version: "1.0.0" }),
    X402_CONFIG
  );

  async init() {
    this.server.paidTool(
      "square",
      "Squares a number",
      0.01,
      { number: z.number() },
      {},
      async ({ number }) => ({
        content: [{ type: "text", text: String(number ** 2) }]
      })
    );

    this.server.registerTool(
      "echo",
      {
        description: "Echo a message",
        inputSchema: { message: z.string() }
      },
      async ({ message }) => ({
        content: [{ type: "text", text: message }]
      })
    );
  }
}

// --- Client agent that calls paid tools ---

export class PayAgent extends Agent<Env> {
  pendingPayments: Record<string, (confirmed: boolean) => void> = {};
  x402Client?: ReturnType<typeof withX402Client>;

  async onStart() {
    const pk = process.env.CLIENT_TEST_PK;
    const solanaKey = process.env.CLIENT_SOLANA_TEST_KEY;
    if (!pk && !solanaKey) {
      console.warn(
        "CLIENT_TEST_PK and CLIENT_SOLANA_TEST_KEY not set — copy .env.example to .env and add a test key"
      );
      return;
    }

    const account = pk
      ? toClientEvmSigner(privateKeyToAccount(pk as `0x${string}`))
      : undefined;
    // The Solana client fetches a recent blockhash over RPC. The public
    // devnet RPC rejects requests from deployed Workers; set SOLANA_RPC_URL.
    const schemes = solanaKey
      ? [
          {
            network: "solana:*" as const,
            client: new ExactSvmClientScheme(
              await createKeyPairSignerFromBytes(
                getBase58Encoder().encode(solanaKey)
              ),
              { rpcUrl: process.env.SOLANA_RPC_URL || undefined }
            )
          }
        ]
      : [];

    const { id } = await this.addMcpServer("pay-mcp", this.env.PayMCP);

    this.x402Client = withX402Client(this.mcp.mcpConnections[id].client, {
      network: NETWORK,
      account,
      schemes
    });
  }

  private async requestPaymentConfirmation(
    requirements: PaymentRequirements[]
  ): Promise<boolean> {
    const confirmationId = crypto.randomUUID().slice(0, 4);

    this.broadcast(
      JSON.stringify({
        type: "payment_required",
        confirmationId,
        requirements
      })
    );

    return new Promise<boolean>((resolve) => {
      this.pendingPayments[confirmationId] = resolve;
    });
  }

  @callable()
  async callTool(toolName: string, args: Record<string, unknown>) {
    if (!this.x402Client) {
      return { text: "Agent not ready", isError: true };
    }

    const res = await this.x402Client.callTool(
      this.requestPaymentConfirmation.bind(this),
      { name: toolName, arguments: args }
    );

    return {
      text:
        res.content[0]?.type === "text"
          ? (res.content[0]?.text ?? "")
          : JSON.stringify(res.content),
      isError: res.isError ?? false
    };
  }

  @callable()
  resolvePayment(confirmationId: string, confirmed: boolean) {
    this.pendingPayments[confirmationId]?.(confirmed);
    delete this.pendingPayments[confirmationId];
  }
}

// --- Routing ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return PayMCP.serve("/mcp", { binding: "PayMCP" }).fetch(
        request,
        env,
        ctx
      );
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response(null, { status: 404 })
    );
  }
};
