export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers,
    readonly responseText: string
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export class AccessBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessBlockedError";
  }
}
