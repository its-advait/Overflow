import { createDatabase } from "../src/client";
import { seed } from "../src/seed";

// Seeds the SIMULATED demo company (COMPANY_NAME) and its two departments.
const handle = await createDatabase({ log: console.log });
await handle.migrate();
const result = await seed(handle.db);
console.log(
  `[database] seeded organization "${result.organization.name}" (SIMULATED) ` +
    `departments=${result.organization.departments.join(",")} agents=${result.agents.length} dialect=${handle.dialect}`,
);
await handle.close();
