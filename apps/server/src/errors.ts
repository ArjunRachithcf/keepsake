/** A refusal a domain module raises; routes turn it into `{ error }` with its status. Messages are for people. */
export class Refused extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: string) { super(message); }
}
