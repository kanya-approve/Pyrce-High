/**
 * Ambient types for `@google-cloud/agones-sdk@1.57.0`. The published
 * package is JS-only; this declaration mirrors the public surface from
 * the upstream `sdks/nodejs/src/agonesSDK.d.ts` (release-1.57.0).
 *
 * Source of truth:
 * https://github.com/googleforgames/agones/blob/release-1.57.0/sdks/nodejs/src/agonesSDK.d.ts
 */
declare module '@google-cloud/agones-sdk' {
  export interface GameServerStatus {
    state?: string;
    address?: string;
    ports?: Array<{ name?: string; port?: number }>;
  }
  export interface GameServer {
    objectMeta?: {
      name?: string;
      namespace?: string;
      labelsMap?: Array<[string, string]>;
      annotationsMap?: Array<[string, string]>;
    };
    spec?: Record<string, unknown>;
    status?: GameServerStatus;
  }
  export class AgonesSDK {
    constructor();
    readonly port: string;
    connect(): Promise<void>;
    close(): void;
    ready(): Promise<Record<string, unknown>>;
    allocate(): Promise<Record<string, unknown>>;
    shutdown(): Promise<Record<string, unknown>>;
    health(errorCallback?: (error: unknown) => void): void;
    getGameServer(): Promise<GameServer>;
    watchGameServer(
      callback: (gameServer: GameServer) => void,
      errorCallback?: (error: unknown) => void,
    ): void;
    setLabel(key: string, value: string): Promise<Record<string, unknown>>;
    setAnnotation(key: string, value: string): Promise<Record<string, unknown>>;
    reserve(durationSeconds: number): Promise<Record<string, unknown>>;
  }
  // The package exports the class as both default and named.
  // eslint-disable-next-line import/no-default-export
  export default AgonesSDK;
}
