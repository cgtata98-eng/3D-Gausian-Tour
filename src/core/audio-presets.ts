/**
 * Built-in BGM presets shipped under `/public/assets/audio/`.
 * Feeds `SceneManifest.audio`. Adding new presets: drop the file into the folder
 * and append an entry here.
 */
export interface AudioPreset {
  id: string;
  label: string;
  /** Public-relative URL written into the manifest. */
  path: string;
}

/** Looping ambient / BGM (manifest.audio). */
export const BGM_PRESETS: AudioPreset[] = [
  { id: 'beach',  label: 'ビーチ',   path: '/assets/audio/ビーチ.mp3' },
  { id: 'forest', label: '森林',     path: '/assets/audio/森林.mp3' },
  { id: 'city',   label: '街',       path: '/assets/audio/街.mp3' },
  { id: 'room',   label: '部屋の音', path: '/assets/audio/部屋の音.mp3' },
];
