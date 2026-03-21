export class FlamecastNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlamecastNotFoundError";
  }
}

export function isFlamecastNotFoundError(error: unknown): error is FlamecastNotFoundError {
  return error instanceof FlamecastNotFoundError;
}
