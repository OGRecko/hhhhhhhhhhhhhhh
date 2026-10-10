import assert from "node:assert/strict";
import { capabilityTokenMatches, createCapabilityToken, hashCapabilityToken } from "./capabilityToken";

const token = createCapabilityToken();
assert.match(token, /^[a-f0-9]{64}$/);
const hash = hashCapabilityToken(token);
assert.match(hash, /^[a-f0-9]{64}$/);
assert.equal(capabilityTokenMatches(token, hash), true);
assert.equal(capabilityTokenMatches("wrong-token-that-is-long-enough", hash), false);
assert.equal(capabilityTokenMatches(undefined, hash), false);
assert.equal(capabilityTokenMatches(token, undefined), false);
console.log("Capability-token tests passed");
