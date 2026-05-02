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
    this.resetReplayBuffer();
  }

  /** Send a typed match-data message to the current match. */
  async sendMatch(op: OpCode, payload: unknown): Promise<void> {
    if (!this.currentMatchId) return;
    const data = JSON.stringify(payload ?? {});
    await this.socket.sendMatchState(this.currentMatchId, op, data);
  }

  private matchDataListeners = new Set<(data: MatchData) => void>();
  private presenceListeners = new Set<(ev: MatchPresenceEvent) => void>();
  private socketListenersWired = false;

  /**
   * Last-seen message per opcode for the handful of opcodes that carry
   * load-bearing state. New subscribers are replayed these so messages
   * that arrived during a scene transition (e.g. PHASE_CHANGE → GameWorld
   * scene boot vs. ROLE_ASSIGNED arriving in the same tick) aren't lost.
   */
  private latestByOpCode = new Map<number, MatchData>();
  private static readonly REPLAY_OPCODES: ReadonlySet<number> = new Set([
    2002, // S2C_PHASE_CHANGE
    2300, // S2C_INITIAL_SNAPSHOT
    2319, // S2C_PLAYER_ROLE_ASSIGNED
    2400, // S2C_INV_FULL
    2700, // S2C_CLOCK_TICK
    2100, // S2C_LOBBY_STATE
  ]);

  /** Register a listener; returns an unsubscribe function. */
  onPresenceChange(cb: (ev: MatchPresenceEvent) => void): () => void {
    this.wireSocketListeners();
    this.presenceListeners.add(cb);
    return () => this.presenceListeners.delete(cb);
  }

  /**
   * Subscribe to incoming match data. Multiple scenes may subscribe — each
   * gets every message. On subscribe we replay the latest state-bearing
   * messages so listeners that registered after the message arrived still
   * see it (the typical scene-transition race).
   */
  onMatchData(cb: (data: MatchData) => void): () => void {
    this.wireSocketListeners();
    this.matchDataListeners.add(cb);
    for (const m of this.latestByOpCode.values()) cb(m);
    return () => this.matchDataListeners.delete(cb);
  }

  private wireSocketListeners(): void {
    if (this.socketListenersWired) return;
    this.socketListenersWired = true;
    this.socket.onmatchdata = (data) => {
      if (NakamaMatchClient.REPLAY_OPCODES.has(data.op_code)) {
        this.latestByOpCode.set(data.op_code, data);
      }
      for (const cb of this.matchDataListeners) cb(data);
    };
    this.socket.onmatchpresence = (ev) => {
      for (const cb of this.presenceListeners) cb(ev);
    };
  }

  /** Forget cached state — call when leaving a match. */
  resetReplayBuffer(): void {
    this.latestByOpCode.clear();
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
