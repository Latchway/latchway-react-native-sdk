interface BabelConfiguration {
  assumptions?: Record<string, boolean>;
  plugins?: unknown[];
  [key: string]: unknown;
}
/**
 * @deprecated Prefer application-owned Babel configuration in docs/langchain.md.
 * Requires @babel/plugin-transform-export-namespace-from as an app devDependency.
 */
export function withLatchwayBabel(config?: BabelConfiguration): BabelConfiguration;
