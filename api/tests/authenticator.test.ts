import assert from "node:assert/strict";
import test from "node:test";

import { extractBearerToken } from "../src/auth/authenticator.js";

test("Bearer token extraction accepts one well-formed token only", () => {
  assert.equal(extractBearerToken("Bearer token.value"), "token.value");
  assert.equal(extractBearerToken("bearer token.value"), "token.value");
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken("token.value"), null);
  assert.equal(extractBearerToken("Bearer "), null);
  assert.equal(extractBearerToken("Bearer first second"), null);
});
