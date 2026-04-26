/**
 * Branded ID types — prevent passing a `userId` where a `matchId` was expected.
 * Construction goes through small helpers so callers don't `as` everywhere.
 */

declare const __brand: unique symbol;
type Brand<TBase, TBrand extends string> = TBase & { readonly [__brand]: TBrand };

export type PlayerId = Brand<string, 'PlayerId'>;
export type MatchId = Brand<string, 'MatchId'>;
export type ItemInstanceId = Brand<string, 'ItemInstanceId'>;
export type CorpseId = Brand<string, 'CorpseId'>;

export const PlayerId = (s: string): PlayerId => s as PlayerId;
export const MatchId = (s: string): MatchId => s as MatchId;
export const ItemInstanceId = (s: string): ItemInstanceId => s as ItemInstanceId;
export const CorpseId = (s: string): CorpseId => s as CorpseId;
