/** Opt-in compiler compatibility for LangChain on the supported RN baseline. */
function withLatchwayBabel(config = {}) {
  if (config.assumptions?.noClassCalls === false) {
    throw new Error("LangChain on React Native requires assumptions.noClassCalls=true. Remove the conflicting assumption.");
  }
  const namespacePlugin = require.resolve("@babel/plugin-transform-export-namespace-from");
  const plugins = config.plugins ?? [];
  const hasNamespacePlugin = plugins.some((entry) => {
    const plugin = Array.isArray(entry) ? entry[0] : entry;
    return plugin === namespacePlugin || plugin === "@babel/plugin-transform-export-namespace-from";
  });
  return {
    ...config,
    // LangChain's Symbol.hasInstance reads fields initialized by super(). The
    // Babel pre-constructor instanceof assertion runs too early. Classes must
    // still be called with new; LangChain's own type checks remain unchanged.
    assumptions: { ...config.assumptions, noClassCalls: true },
    plugins: hasNamespacePlugin ? [...plugins] : [namespacePlugin, ...plugins],
  };
}

module.exports = { withLatchwayBabel };
