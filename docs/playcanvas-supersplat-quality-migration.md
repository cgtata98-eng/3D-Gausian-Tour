# PlayCanvas 経路を SuperSplat 同等品質に引き上げる移行手順

Lab (`C:\Users\takyu\Desktop\ビューア`) で `playcanvas/supersplat-viewer` の本質を移植し、PlayCanvas v2 default の GSplat 出力を SuperSplat 同等品質まで持ち上げた。本ドキュメントは確認済みの差分を本番に当てる手順。

> **状態確認**：本番 `src/ui/Viewer.tsx:56` は default engine が `'spark'` に切替済み。Spark 経路は既に SuperSplat 並みなので **本ドキュメントの修正は PlayCanvas 経路（旧 SceneManager / gsplat-loader 系）を再評価する場合の手順**。Spark 運用を続けるなら未着手で OK。

---

## 何が問題だったか

PlayCanvas v2 の **default GSplat fragment 出力**は

```glsl
gaussianColor = vec4(prepareOutputFromGamma(max(clr.xyz, 0.0), -center.view.z), clr.w);
```

で、`prepareOutputFromGamma` 内部が

```
gamma → linear → toneMap → gamma   （全段 8bit framebuffer 経由）
```

の往復をやる。8bit 精度のラウンドトリップで色が滲み、結果として **壁の黄ばみ・splat 透け感** が出ていた。

`playcanvas/supersplat-viewer` はこれを **CameraFrame ポストパイプライン + HDR float framebuffer + gamma passthrough** で回避していた。

---

## 適用する 4 点（核心）

### 1. CameraFrame ポストパイプラインを有効化

```ts
import {
  CameraFrame,
  PIXELFORMAT_RGBA16F,
  PIXELFORMAT_RGBA32F,
  TONEMAP_LINEAR,
} from 'playcanvas';

// camera entity 作成後、`app.start()` の前後どちらでも可（カメラがあれば OK）
const cameraFrame = new CameraFrame(app, camera.camera!);
cameraFrame.rendering.toneMapping = TONEMAP_LINEAR;
cameraFrame.rendering.renderFormats = [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F];
cameraFrame.update();

// dispose 時は cameraFrame.destroy()
```

**効果**: バックバッファを RGBA16F float に上げ、tonemap・gamma を末端で一発処理。中間段の 8bit ロスが消える。

### 2. `gsplatOutputVS` を gamma passthrough に置換

```ts
import { ShaderChunks, SHADERLANGUAGE_GLSL } from 'playcanvas';

ShaderChunks
  .get(app.graphicsDevice, SHADERLANGUAGE_GLSL)
  .set('gsplatOutputVS', `
    vec3 prepareOutputFromGamma(vec3 gammaColor, float depth) {
        return gammaColor;
    }
  `);
```

**効果**: gsplat shader 内の gamma decode/re-encode 往復をスキップ。最終 gamma 補正は CameraFrame 末端に任せる。CameraFrame と必ずセットで適用すること。

### 3. radialSorting を有効化

```ts
app.scene.gsplat.radialSorting = true;
```

**効果**: 視線ベクトルとのドット積でなく半径距離でソート。回転時に発生する短時間 unsort を抑制。

### 4. graphics device オプションを SuperSplat 仕様に

```ts
const device = await createGraphicsDevice(canvas, {
  deviceTypes: [DEVICETYPE_WEBGL2],
  antialias: false,
  depth: false,
  stencil: false,
  xrCompatible: false,
  powerPreference: 'high-performance',
});
```

**変更点**:
- `depth: false` / `stencil: false` 追加（GSplat に不要、HDR バッファを軽くする）
- `preserveDrawingBuffer: true` は **削除**（thumbnail 取得経路の見直しが必要）

**注意（thumbnail 機能との関係）**: 本番の `app-init.ts` は `canvas.toDataURL()` 用に `preserveDrawingBuffer: true` を入れている。これを外すと `canvas.toDataURL()` で取れる絵が空になるケースが出る。代替手段：

- `renderNextFrame = true` を立てた直後の `app.once('frameend', () => canvas.toDataURL())` 同期キャプチャに切替
- もしくは off-screen の `RenderTarget` に 1 フレーム描画してそこから読む

`preserveDrawingBuffer` を残したまま 1〜3 だけ適用しても見た目は改善する（性能ペナルティ少しあり）。段階移行する場合は「1〜3 だけ先に当てる → thumbnail パスを書き換え → 4 を当てる」の 2 段階推奨。

---

## 補助的な 2 点（既存コードの罠）

### 5. SH 切替は `setDefine('SH_BANDS', ...)` で

`gsplat-loader.ts` の `(entity.gsplat as any).highQualitySH = true` は **PLY では効かない**。component の `_highQualitySH` default が `true` なので setter が早期 return し、instance に伝わらない。SOG だけ別経路で効く。

正しい方法（PLY/SOG 共通）:

```ts
const mat = entity.gsplat.instance?.material;
if (mat) {
  mat.setDefine('SH_BANDS', String(shDegree));   // 0..3
  mat.update();
}
```

`update()` で shader 再コンパイルが走るので、ロード直後に 1 回呼べば済む。

### 6. splatScale は `gsplatModifyVS` chunk + uniform で

`mat.setParameter('splatScale', ...)` は default shader が読まないので無効。chunk 経由：

```ts
const VIEWER_MODIFY_CHUNK = `
uniform float viewerSplatScale;

void modifySplatCenter(inout vec3 center) {}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    scale *= viewerSplatScale;
}

void modifySplatColor(vec3 center, inout vec4 color) {}
`;

mat.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyVS', VIEWER_MODIFY_CHUNK);
mat.setParameter('viewerSplatScale', 1.15);   // 1.15〜1.25 が SuperSplat 寄り
mat.update();
```

---

## 適用先ファイル

| 修正 | 本番ファイル | 行 |
|------|--------------|----|
| 1. CameraFrame | `src/engine/app-init.ts` | `app.root.addChild(camera);` の直後 |
| 2. gamma passthrough chunk | `src/engine/app-init.ts` | 同上、CameraFrame と同じブロック |
| 3. radialSorting | `src/engine/app-init.ts` | `app.start()` 前 |
| 4. graphics device | `src/engine/app-init.ts` | `createGraphicsDevice(...)` 引数 |
| 5. SH define | `src/engine/gsplat-loader.ts` | `loadGSplat` の `asset.on('load')` 内、現状 `highQualitySH = true` してる場所 |
| 6. splatScale chunk | `src/engine/gsplat-loader.ts` | 5 と同じブロック |

---

## 検証手順

1. `npm run build` がエラーなく通ること
2. `npm run dev` で起動 → ハードリロード
3. PlayCanvas を default engine に戻す（`Viewer.tsx:56` を `'spark'` → 一時的に `'playcanvas'`、ただし PlayCanvas 系の Viewer 経路がそもそも通っているかは別途要確認）
4. Lab で改善確認済みの room4 シーンを開いて以下が満たされること：
   - 壁が黄ばまずクリーンな白
   - 紙ペンダントランプの**縦の継ぎ目線が見える**
   - ドアの木目・エッジがシャープ
   - splat の「透け感」が減る
5. SuperSplat エディタで開いた同シーンと並べて視覚比較

---

## ロールバック

各修正は独立しているので個別 revert 可能。特に **1 と 2 はセット**で当てる／戻すこと（片方だけだと色がおかしくなる）。

3 (radialSorting) と 4 (graphics device) は単独 revert 安全。5/6 は default に戻すと SH/splatScale の調整が効かなくなるだけ。

---

## 参考実装

- Lab 側の動作する完成形: `C:\Users\takyu\Desktop\ビューア\src\adapters\playcanvas-adapter.ts`
- 元ネタ: [`playcanvas/supersplat-viewer`](https://github.com/playcanvas/supersplat-viewer) の `src/viewer.ts` (`configureCamera()` 内)

---

## 補足：なぜ Lab で実証済みなのに本番では未適用か

- 本番 `Viewer.tsx` は既に **Spark default**（前回コミットで切替）に倒した
- Spark は標準で SuperSplat 並みの品質なので、追加工事不要で SuperSplat 同等出力が得られる状態
- PlayCanvas 経路を残すかどうかは運用判断。残す価値があるシナリオは PLY/SPZ の **SOG 対応**（Spark は SOG 非対応）や、PlayCanvas に依存している既存機能（collision, viewpoint, panorama 切替など）との統合度合い
