import test from "node:test";
import assert from "node:assert/strict";

import {
  appControlCooldownUntilMs,
  markAppControlCooldown,
  markTransportError,
  parseTimestampMs,
  shouldPreferAppServer,
} from "../lib/native-transport-state.mjs";

test("parseTimestampMs returns epoch ms for valid timestamps and zero otherwise", () => {
  assert.equal(parseTimestampMs("2026-04-19T10:00:00.000Z"), Date.parse("2026-04-19T10:00:00.000Z"));
  assert.equal(parseTimestampMs("not a date"), 0);
});

test("shouldPreferAppServer requires fallback and respects explicit transport mode", () => {
  assert.equal(shouldPreferAppServer({}, { nativeIngressTransport: "app-server" }, 1000), false);
  assert.equal(
    shouldPreferAppServer({}, { nativeFallbackHelperPath: "/tmp/helper", nativeIngressTransport: "app-server" }, 1000),
    true,
  );
});

test("shouldPreferAppServer uses app-control cooldown while it is active", () => {
  const binding = { appControlCooldownUntil: "2026-04-19T10:00:10.000Z" };
  const config = { nativeFallbackHelperPath: "/tmp/helper", nativeIngressTransport: "app-control" };
  assert.equal(shouldPreferAppServer(binding, config, Date.parse("2026-04-19T10:00:00.000Z")), true);
  assert.equal(shouldPreferAppServer(binding, config, Date.parse("2026-04-19T10:00:11.000Z")), false);
  assert.equal(appControlCooldownUntilMs(binding), Date.parse("2026-04-19T10:00:10.000Z"));
});

test("markAppControlCooldown records the cooldown and transport error kind", () => {
  const binding = {};
  const until = markAppControlCooldown(
    binding,
    { appControlCooldownMs: 5000 },
    { kind: "renderer_crash" },
    Date.parse("2026-04-19T10:00:00.000Z"),
  );
  assert.equal(until, "2026-04-19T10:00:05.000Z");
  assert.equal(binding.appControlCooldownUntil, "2026-04-19T10:00:05.000Z");
  assert.equal(binding.lastTransportErrorAt, "2026-04-19T10:00:00.000Z");
  assert.equal(binding.lastTransportErrorKind, "renderer_crash");
});

test("markAppControlCooldown is a no-op when cooldown is disabled", () => {
  const binding = {};
  assert.equal(markAppControlCooldown(binding, { appControlCooldownMs: 0 }, {}, 1000), null);
  assert.deepEqual(binding, {});
});

test("markTransportError records a best-effort error kind", () => {
  const binding = {};
  markTransportError(binding, {}, Date.parse("2026-04-19T10:00:00.000Z"));
  assert.equal(binding.lastTransportErrorAt, "2026-04-19T10:00:00.000Z");
  assert.equal(binding.lastTransportErrorKind, "send_failed");
});
