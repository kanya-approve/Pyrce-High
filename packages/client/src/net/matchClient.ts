import type { Client, Match, MatchPresenceEvent, Session, Socket } from '@heroiclabs/nakama-js';
import {
  type CreateMatchRequest,
  type CreateMatchResponse,
  type ListMatchesResponse,
  type LoadProfileResponse,
  type MatchListing,
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
    return await this.socket.joinMatch(matchId);
  }

  async leaveMatch(matchId: string): Promise<void> {
    await this.socket.leaveMatch(matchId);
  }

  onPresenceChange(cb: (ev: MatchPresenceEvent) => void): void {
    this.socket.onmatchpresence = cb;
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
