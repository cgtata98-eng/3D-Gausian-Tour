/**
 * 仮パノラマ（方角ガイド）— 360°画像が未割当のウォークノードを表示するときに
 * その場で生成する equirect 画像。どの向きが図面のどの方向かを大きく描くので、
 * 撮影前でも stepForward の「向き → 隣セル」対応を目で確認できる。
 *
 * u ↔ yaw の対応: hdri-loader の SKYBOX_Y_FLIP (180° Y 回転) 込みで
 * 「camera yaw 0° = 画像の水平中央 (u = 0.5)」。一般式は u(ψ) = (0.5 − ψ/360) mod 1
 * （equirect-skybox.ts のシェーダ lon 計算 + 180° 回転から導出）。
 */

interface PlaceholderNode {
  id: string;
  cell?: { row: number; col: number };
}

const W = 2048;
const H = 1024;

/** yaw (deg, camera convention) → 画像 x 座標。 */
function xOfYaw(yawDeg: number): number {
  const u = (((0.5 - yawDeg / 360) % 1) + 1) % 1;
  return u * W;
}

const DIRS = [
  { yaw: 0, arrow: '↑', label: '図面の上', color: '#ef4444' },
  { yaw: 90, arrow: '←', label: '図面の左', color: '#f59e0b' },
  { yaw: 180, arrow: '↓', label: '図面の下', color: '#3b82f6' },
  { yaw: 270, arrow: '→', label: '図面の右', color: '#22c55e' },
];

const cache = new Map<string, string>();

export function walkPlaceholderPanorama(node: PlaceholderNode): string {
  const hit = cache.get(node.id);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  // 空 / 床
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  sky.addColorStop(0, '#bfdbfe');
  sky.addColorStop(1, '#eff6ff');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H * 0.5);
  const ground = g.createLinearGradient(0, H * 0.5, 0, H);
  ground.addColorStop(0, '#e5e7eb');
  ground.addColorStop(1, '#9ca3af');
  g.fillStyle = ground;
  g.fillRect(0, H * 0.5, W, H * 0.5);
  g.strokeStyle = 'rgba(31,41,55,0.4)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(0, H * 0.5);
  g.lineTo(W, H * 0.5);
  g.stroke();

  // 端で切れても見えるよう、x と x±W の3回描画するヘルパ
  const wrapped = (x: number, draw: (x: number) => void) => {
    draw(x);
    draw(x - W);
    draw(x + W);
  };

  // ±45° 境界（前進判定の分かれ目）
  g.setLineDash([14, 18]);
  g.strokeStyle = 'rgba(31,41,55,0.25)';
  g.lineWidth = 3;
  for (const b of [45, 135, 225, 315]) {
    wrapped(xOfYaw(b), (x) => {
      g.beginPath();
      g.moveTo(x, H * 0.12);
      g.lineTo(x, H * 0.88);
      g.stroke();
    });
  }
  g.setLineDash([]);
  g.textAlign = 'center';

  for (const d of DIRS) {
    wrapped(xOfYaw(d.yaw), (x) => {
      // 方向バンド
      g.fillStyle = `${d.color}22`; // 8桁 hex (α)
      g.fillRect(x - 130, 0, 260, H);
      // 矢印 + 角度 + 図面方向
      g.fillStyle = d.color;
      g.font = 'bold 190px sans-serif';
      g.fillText(d.arrow, x, H * 0.30);
      g.font = 'bold 76px sans-serif';
      g.fillText(`${d.yaw}°`, x, H * 0.40);
      g.font = 'bold 64px sans-serif';
      g.fillText(d.label, x, H * 0.475);
      // ノード ID（床側）
      g.fillStyle = 'rgba(31,41,55,0.8)';
      g.font = 'bold 150px sans-serif';
      g.fillText(node.id, x, H * 0.68);
    });
  }

  // キャプション（正面 = yaw 0 の上部）
  wrapped(xOfYaw(0), (x) => {
    g.fillStyle = 'rgba(31,41,55,0.55)';
    g.font = 'bold 44px sans-serif';
    g.fillText(
      `仮画像 — 360°画像 未割当${node.cell ? `  cell(${node.cell.row},${node.cell.col})` : ''}`,
      x,
      H * 0.09,
    );
  });

  const url = c.toDataURL('image/jpeg', 0.8);
  cache.set(node.id, url);
  return url;
}
