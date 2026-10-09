import { Hono } from "hono";
import { Agent, callable, routeAgentRequest } from "agents";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme as registerClientEvmScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerServerEvmScheme } from "@x402/evm/exact/server";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme as ExactSvmClientScheme } from "@x402/svm/exact/client";
import { registerExactSvmScheme as registerServerSvmScheme } from "@x402/svm/exact/server";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";

const BASE_SEPOLIA = "eip155:84532";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export class PayAgent extends Agent<Env> {
  fetchWithPay?: ReturnType<typeof wrapFetchWithPayment>;

  async onStart() {
    const pk = process.env.CLIENT_TEST_PK;
    const solanaKey = process.env.CLIENT_SOLANA_TEST_KEY;
    if (!pk && !solanaKey) {
      console.warn(
        "CLIENT_TEST_PK and CLIENT_SOLANA_TEST_KEY not set — copy .env.example to .env and add a test key"
      );
      return;
    }

    const client = new x402Client();
    if (pk) {
      const account = privateKeyToAccount(pk as `0x${string}`);
      console.log("Agent will pay on Base Sepolia from:", account.address);
      registerClientEvmScheme(client, { signer: toClientEvmSigner(account) });
    }
    if (solanaKey) {
      const signer = await createKeyPairSignerFromBytes(
        getBase58Encoder().encode(solanaKey)
      );
      console.log("Agent will pay on Solana devnet from:", signer.address);
      // The Solana client fetches a recent blockhash over RPC. The public
      // devnet RPC rejects requests from deployed Workers; set SOLANA_RPC_URL.
      client.register(
        "solana:*",
        new ExactSvmClientScheme(signer, {
          rpcUrl: process.env.SOLANA_RPC_URL || undefined
        })
      );
    }
    this.fetchWithPay = wrapFetchWithPayment(fetch, client);
  }

  @callable()
  async fetchProtectedRoute() {
    if (!this.fetchWithPay) {
      return {
        text: "Agent not ready — CLIENT_TEST_PK not configured",
        isError: true
      };
    }

    const paidUrl = "http://localhost:5173/protected-route";
    const res = await this.fetchWithPay(paidUrl, {});
    const data = await res.json();

    return {
      text: JSON.stringify(data, null, 2),
      isError: !res.ok
    };
  }
}

const app = new Hono<{ Bindings: Env }>();

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"
});
const resourceServer = new x402ResourceServer(facilitatorClient);
registerServerEvmScheme(resourceServer);
registerServerSvmScheme(resourceServer);

// Accept payment on each network that has a recipient configured. A Solana
// recipient must already hold a devnet USDC token account.
const accepts = [
  { network: BASE_SEPOLIA, payTo: process.env.SERVER_ADDRESS },
  { network: SOLANA_DEVNET, payTo: process.env.SERVER_SOLANA_ADDRESS }
]
  .filter((option) => option.payTo)
  .map(({ network, payTo }) => ({
    scheme: "exact",
    price: "$0.10",
    network: network as `${string}:${string}`,
    payTo: payTo as string
  }));

app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts,
        description: "Access to premium content",
        mimeType: "application/json"
      }
    },
    resourceServer
  )
);

app.get("/protected-route", (c) => {
  return c.json({
    message: "This content is behind a paywall. Thanks for paying!"
  });
});

app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res || c.json({ error: "Not found" }, 404);
});

export default app;
