const MICROPHONE_PERMISSION_ERRORS = new Set(['NotAllowedError', 'PermissionDeniedError'])

export function isMicrophonePermissionError(error: unknown): boolean {
  return error instanceof DOMException && MICROPHONE_PERMISSION_ERRORS.has(error.name)
}

export function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return fallback
}
