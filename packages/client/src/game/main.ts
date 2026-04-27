import { AUTO, Game, Scale, type Types } from 'phaser';
import { Boot } from './scenes/Boot';
import { EndScene } from './scenes/EndScene';
import { GameWorld } from './scenes/GameWorld';
import { Hud } from './scenes/Hud';
import { Lobby } from './scenes/Lobby';
import { LobbyBrowser } from './scenes/LobbyBrowser';

const config: Types.Core.GameConfig = {
  type: AUTO,
  width: 1024,
  height: 768,
  parent: 'game-container',
  backgroundColor: '#0a1018',
  scale: {
    mode: Scale.FIT,
    autoCenter: Scale.CENTER_BOTH,
  },
  scene: [Boot, LobbyBrowser, Lobby, GameWorld, Hud, EndScene],
};

const StartGame = (parent: string): Phaser.Game => {
  return new Game({ ...config, parent });
};

export default StartGame;
