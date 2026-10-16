/**
 * The DELETE answered 401: this device's session was already dead. Either
 * the account is deleted (an earlier confirm committed and its response was
 * lost) or the session ended. The local session has been ended either way.
 */
export class AccountSessionEndedError extends Error {
  readonly name = 'AccountSessionEndedError';
  constructor() {
    super('Your session has ended.');
  }
}
