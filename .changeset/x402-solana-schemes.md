---
"agents": minor
---

`withX402` and `withX402Client` from `agents/x402` accept payment `schemes`, so paid MCP tools can charge and pay on Solana with `ExactSvmScheme` from `@x402/svm`. The `solana` and `solana-devnet` network names map to CAIP-2. See [examples/x402-mcp](https://github.com/cloudflare/agents/tree/main/examples/x402-mcp).
