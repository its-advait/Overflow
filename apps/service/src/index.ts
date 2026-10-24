import { createServer } from "node:http";
import { CHAIN_ID, PACKAGE_NAME as SCHEMAS } from "@overflow/schemas";
import { API_STATUS } from "./api/index.js";
import { CHAIN_STATUS } from "./chain/index.js";
import { FACILITATOR_STATUS } from "./facilitator/index.js";
import { ORCHESTRATION_STATUS } from "./orchestration/index.js";
import { SELLERS_STATUS } from "./sellers/index.js";

const port = Number(new URL(process.env["SERVICE_URL"] ?? "http://localhost:4000").port || 4000);

const status = {
  service: "@overflow/service",
  scaffold: true,
  chainId: CHAIN_ID,
  modules: {
    api: API_STATUS,
    orchestration: ORCHESTRATION_STATUS,
    facilitator: FACILITATOR_STATUS,
    sellers: SELLERS_STATUS,
    chain: CHAIN_STATUS,
  },
  dependsOn: [SCHEMAS],
};

const server = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(status));
});

server.listen(port, () => {
  console.log(`[scaffold] @overflow/service listening on http://localhost:${port}`);
});
