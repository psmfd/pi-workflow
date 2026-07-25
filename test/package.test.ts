import assert from "node:assert/strict";
import test from "node:test";

import registerPiWorkflow, { PI_WORKFLOW_API_VERSION } from "../src/index.js";

void test("exports a loadable pi extension factory", () => {
  assert.equal(typeof registerPiWorkflow, "function");
  assert.equal(PI_WORKFLOW_API_VERSION, 1);
});
