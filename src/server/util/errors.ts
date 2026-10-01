/** An error caused by the request/input (reported to the client with a 4xx status, not logged as a crash). */
export class UserError extends Error {
  constructor(
    message: string,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
