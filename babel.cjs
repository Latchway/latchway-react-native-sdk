/** @deprecated Prefer application-owned Babel configuration (docs/langchain.md). */
function withLatchwayBabel(config = {}) {
  if (config.assumptions?.noClassCalls === false) {
    throw new Error("LangChain on React Native requires assumptions.noClassCalls=true. Remove the conflicting assumption.");
  }
  let namespacePlugin;
  try {
    namespacePlugin = require.resolve("@babel/plugin-transform-export-namespace-from");
  } catch (cause) {
    throw new Error(
      "@latchway/react-native/babel requires an app-owned devDependency. Run npm install --save-dev @babel/plugin-transform-export-namespace-from@7.29.7, or migrate to the Babel configuration in docs/langchain.md.",
      { cause },
    );
  }
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
