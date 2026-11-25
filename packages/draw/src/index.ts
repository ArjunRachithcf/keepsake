// The draw ("draw names", ADR 0004) as pure functions: no I/O, no clock, no randomness of its own (the server passes a
// cryptographic source in). M3 fills it in; it is tested exhaustively.

/** A participant of a draw, by id only: the draw never sees names. */
export type ParticipantId = string;

/** The version of the draw's rules; M3 starts at 1. */
export const DRAW_RULES_VERSION = 0;
