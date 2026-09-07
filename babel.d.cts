interface BabelConfiguration {
  assumptions?: Record<string, boolean>;
  plugins?: unknown[];
  [key: string]: unknown;
}
/** Preserves existing configuration and adds explicit LangChain compatibility. */
export function withLatchwayBabel(config?: BabelConfiguration): BabelConfiguration;
