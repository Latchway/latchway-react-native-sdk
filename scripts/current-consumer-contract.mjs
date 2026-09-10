import assert from "node:assert/strict";

// Current source ABI, not a claim about already-published package receipts.
export const CURRENT_BRIDGE_METHODS = Object.freeze([
  "appCommand", "configureComponent", "startRequest", "readResponseChunk", "closeResponse",
  "refresh", "quota", "diagnostics", "componentDiagnostics", "prepareComponents", "replaceComponent",
  "rootComponentDiagnostics", "revokeComponent", "revoke", "revokeFamily", "cancel", "dispose",
]);

function assertMethods(methods) {
  assert.deepEqual([...methods].sort(), [...CURRENT_BRIDGE_METHODS].sort(),
    "Current source requires the 17-method fresh-account bridge; historical archives need their versioned verification scripts.");
}

export function assertCurrentNativeSpec(source) {
  assertMethods([...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\(/gmu)].map(match => match[1]));
  assert.doesNotMatch(source, /\bidentityToken\s*:/u, "Native transport cannot accept a transient identity token.");
}

export function assertCurrentNativeSchema(schema) {
  const spec = schema.modules?.NativeLatchway?.spec;
  assert.ok(spec, "NativeLatchway is missing from generated Codegen output.");
  const methods = spec.methods ?? spec.properties;
  assert.ok(Array.isArray(methods), "Codegen output contains no native methods.");
  assertMethods(methods.map(method => method.name));
  for (const method of methods) {
    assert.ok(!(method.typeAnnotation?.params ?? []).some(parameter => parameter.name === "identityToken"),
      "Generated native transport cannot accept a transient identity token.");
  }
}
