// No imports: Hermes must have these symbols before stream classes evaluate.
for (const name of ['asyncIterator', 'asyncDispose', 'dispose']) {
  if (typeof Symbol[name as keyof SymbolConstructor] === 'undefined') {
    Object.defineProperty(Symbol, name, {value: Symbol.for(`Symbol.${name}`)});
  }
}

export {};
