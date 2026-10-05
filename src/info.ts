// Stack metadata. Pure data, no Pi imports.
export const STACK_INFO = {
  name: "pi-generation-recovery-next",
  pinxNamespace: "pinx",
  contractVersion: 1,
  customTypes: {
    checkpoint: "pinx.recovery.checkpoint",
    attempt: "pinx.recovery.attempt",
  },
  stateRoot: "pinx/generation-recovery-next",
} as const;
