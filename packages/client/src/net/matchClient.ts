import type {
  Client,
  Match,
  MatchData,
  MatchPresenceEvent,
  Session,
  Socket,
} from '@heroiclabs/nakama-js';
import {
  type CreateMatchRequest,
  type CreateMatchResponse,
  type ListMatchesResponse,
  type LoadProfileResponse,
  type MatchListing,
  type OpCode,
  type ProfileV1,
  RpcId,
  type SaveProfileRequest,
  type SaveProfileResponse,
} from '@pyrce/shared';

/**
 * Thin wrapper around the Nakama client + socket for the operations the
 * client UI needs. Methods return parsed typed payloads (not Nakama's
 * `{ payload: jsonString }` envelope).
 */
export class NakamaMatchClient {
  /** id of the match the user is currently joined to (server-issued). */
  currentMatchId: string | null = null;

  constructor(
    private readonly client: Client,
    private readonly socket: Socket,
    private readonly session: Session,
  ) {}

  get userId(): string {
    return this.session.user_id ?? '';
  }

  get username(): string {
    return this.session.username ?? '';
  }

  // ---------- Profile RPCs ----------

  async loadProfile(): Promise<LoadProfileResponse> {
    return await this.callRpc<LoadProfileResponse>(RpcId.LoadProfile, {});
  }

  async saveProfile(profile: ProfileV1): Promise<SaveProfileResponse> {
    const req: SaveProfileRequest = { profile };
    return await this.callRpc<SaveProfileResponse>(RpcId.SaveProfile, req);
  }

  // ---------- Match listing & creation ----------

  async listMatches(limit = 20): Promise<MatchListing[]> {
    const res = await this.callRpc<ListMatchesResponse>(RpcId.ListMatches, { limit });
    return res.matches;
  }

  async createMatch(name?: string, gameModeId?: string): Promise<CreateMatchResponse> {
    const req: CreateMatchRequest = {};
    if (name) req.name = name;
    if (gameModeId) req.gameModeId = gameModeId;
    return await this.callRpc<CreateMatchResponse>(RpcId.CreateMatch, req);
  }

  // ---------- Realtime match join/leave ----------

  async joinMatch(matchId: string): Promise<Match> {
    const m = await this.socket.joinMatch(matchId);
    this.currentMatchId = m.match_id;
    return m;
  }

  async leaveMatch(matchId: string): Promise<void> {
    await this.socket.leaveMatch(matchId);
    if (this.currentMatchId === matchId) this.currentMatchId = null;
  }

  /** Send a typed match-data message to the current match. */
  async sendMatch(op: OpCode, payload: unknown): Promise<void> {
    if (!this.currentMatchId) return;
    const data = JSON.stringify(payload ?? {});
    await this.socket.sendMatchState(this.currentMatchId, op, data);
  }

  onPresenceChange(cb: (ev: MatchPresenceEvent) => void): void {
    this.socket.onmatchpresence = cb;
  }

  /**
   * Subscribe to incoming match data. The latest registered callback wins —
   * scenes register on `create()` and the previous scene's callback is
   * naturally replaced when the next scene mounts.
   */
  onMatchData(cb: (data: MatchData) => void): void {
    this.socket.onmatchdata = cb;
  }

  // ---------- Internals ----------

  private async callRpc<T>(id: string, payload: object): Promise<T> {
    const result = await this.client.rpc(this.session, id, payload);
    const body = result.payload as unknown;
    if (typeof body === 'string') return JSON.parse(body) as T;
    if (body && typeof body === 'object') return body as T;
    return {} as T;
  }
}
