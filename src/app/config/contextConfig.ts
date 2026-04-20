// Context configuration for Roo

export interface ContextConfig {
  maxTokens: number;
  retentionPolicy: 'session' | 'persistent' | 'hybrid';
  compressionThreshold: number;
  defaultContextWindow: number;
  intelligentContextCondensing: boolean;
  condensingThreshold: [number, number];
  intentIdentificationThreshold: number; // Confidence threshold (0-1)
  ambiguousIntentHandling: 'reject' | 'clarify' | 'best-guess';
  intentBlacklist?: string[]; // Invalid/unsupported intents
  chunkReading: {
    enabled: boolean;
    chunkSize: number; // Size of each chunk in bytes
    maxChunks: number; // Maximum number of chunks to process
  };
}

export const defaultContextConfig: ContextConfig = {
  maxTokens: 4096,
  retentionPolicy: 'hybrid',
  compressionThreshold: 0.7,
  defaultContextWindow: 2048,
  intelligentContextCondensing: true,
  condensingThreshold: [0.8, 0.9],
  intentIdentificationThreshold: 0.8,
  ambiguousIntentHandling: 'clarify',
  intentBlacklist: [],
  chunkReading: {
    enabled: false,
    chunkSize: 1024 * 1024, // 1MB default chunk size
    maxChunks: 10, // Default max chunks to process
  },
};

export const getContextConfig = (overrides?: Partial<ContextConfig>): ContextConfig => ({
  ...defaultContextConfig,
  ...overrides
});