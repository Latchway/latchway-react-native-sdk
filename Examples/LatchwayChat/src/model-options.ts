// App-specific route policy only. The adapter owns stateless serialization,
// no-retry defaults and strict tool binding. Reasoning is never guessed.
export const modelOptions = {
  reasoning: {effort: 'none'},
  chatOptions: {maxTokens: 1024},
} as const;
