/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NAKAMA_HOST?: string;
  readonly VITE_NAKAMA_PORT?: string;
  readonly VITE_NAKAMA_USE_SSL?: string;
  readonly VITE_NAKAMA_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
