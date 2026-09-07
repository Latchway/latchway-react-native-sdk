// This module deliberately has no imports. Computed stream methods must see
// these symbols before any dependency is evaluated on Hermes 0.82.
for (const name of ["asyncIterator", "asyncDispose", "dispose"] as const) {
  if (typeof Symbol[name] === "undefined") {
    Object.defineProperty(Symbol, name, { value: Symbol.for(`Symbol.${name}`) });
  }
}

export {};
