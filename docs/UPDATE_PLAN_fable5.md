# 3D_CG_GS アップデート計画（fable5 実装ハンドオフ）

作成: 2026-07-05 / 対象ブランチ: `feat/ai-image-providers-collision-render`
このドキュメントは fable5 が実装するための仕様書。**Part A=既存バグ修正**、**Part B=新機能**、**Part C=データ構造の評価と修正提案**。
不変ルール（全実装共通・破ったら本番ビューアが壊れる）:
- **mapYaw 不変**: 方向キー / yaw スライダー / 図面コーンは `mapYaw` のみ書く。`target` とライブカメラは絶対に触らない。
- 図面ドラッグ/クリックは `mapPosition` のみ書く。カメラ反映は明示アクション（📍 / bakeViewpointToCamera）に分離。

---

## Part A — 既存バグ・エラー（優先度順）

型チェック(`tsc -b`)通過・ビルドは健全。以下はランタイムバグと lint。

### 🔴 High
| # | 場所 | 症状 / 原因 | 修正方針 |
|---|------|-------------|----------|
| A1 | `engine/scene-manager.ts:643-708` (`setActivePlan`) | プラン切替で splat は再ロードされるがコリジョンが再読込されず、歩行が**前プランの床/壁**を使う。AABBカルも旧splat基準のまま。 | 切替時に collision 破棄→新 `plan.collision` 再ロード→新splatのAABBで再カル→controllerへ再同期。 |
| A2 | `engine/three/three-scene-manager.ts:507` (`setActivePlan`) | Three(spark/mkkellogg)経路では**プラン切替が完全にno-op**。 | PlayCanvas側 `setActivePlan` 相当（splat+collision+初期視点）を移植。 |

### 🟠 Medium
| # | 場所 | 症状 / 原因 | 修正方針 |
|---|------|-------------|----------|
| A3 | `ui/FloorPlanMiniMap.tsx:282,304,318` | 図面ドットのドラッグ後に**ファントムクリック**が発火→`jumpToViewpoint`でカメラ移動＋視点切替（分離ルール違反）。`if(!isD)`が読む`draggingId`はclick時点で既にnull。 | React stateでなく同期`dragRef`（mousedownで立て、click判定後クリア）でクリック抑止。 |
| A4 | `ui/LeftPanel.tsx:1014` ↔ `worker/index.ts:205`/`vite.config.ts:130` | OpenAIで解像度(1K/2K/4K)が無視。client=`imageSize`送信 / server=`body.size`参照でフィールド名不一致。 | フィールド名統一。4KがOpenAI非対応ならUI側で無効化。 |
| A5 | `vite.config.ts` `aiImageProxy` vs `worker/index.ts` | dev proxyが本番Workerとロジック乖離（キー欠落 dev=500/本番=401、Originチェック・本文サイズ上限・Basic認証・model文字種検証が dev に無い）。dev で通って本番で落ちる。 | dev proxyを Worker と同一ガードに揃える（共通化推奨）。 |
| A6 | `engine/scene-manager.ts:1021-1071` | stray三角形のAABBカルがsplat AABB安定前に走る→null時**カルされず**浮遊ボックス残存でワープ／タイト時は部屋端の床を削る（余白1.0m）。 | AABB安定までリトライ or bounds=null時はカルをスキップして後で再試行。余白再検討。 |
| A7 | `engine/scene-manager.ts:886-901` + `camera-controller.ts:637-642` | ミラー受信側が位置を捨て回転だけ反映。`setPosition`後の`applyPose()`末尾が`entity.setPosition(playerPos)`でstale位置に上書き。 | メッセージ位置を`playerPos`へ反映してから`applyPose()`。 |
| A8 | `engine/three/three-camera-controller.ts:481-494` / `three-mesh-raycaster.ts:59-64` | Three側の床スナップが未ハードニング（eye起点3mレイ・法線フィルタ無し・段差クランプ無し・ハードスナップ）。spark/mkkelloggで壁面/浮遊物にワープ。 | PlayCanvas側の足元起点+`minAbsNormalY`+段差クランプ+Y平滑化を移植。 |

### 🟡 Low-Med
| # | 場所 | 症状 | 修正方針 |
|---|------|------|----------|
| A9 | `store/scene-store.ts:225` ↔ `scene-manager.ts:700-703` | プラン切替で`linkPlanCamera`ON時、ハイライトが`viewpoints[0]`のまま残る。 | link ON でもアクティブ視点を`startViewpointId`に補正。 |
| A10 | `engine/camera-controller.ts:510-516` | 床未取得時フォールバックが絶対Yにeye-height(≈1.6)を書き空中/地下にジャンプ。 | 絶対Y代入をやめ床取得まで前フレームY保持。 |
| A11 | `utils/auth.ts:63-80` | `getAuthRole()`/`getAuthHeader()`がパース失敗時adminを返しTTL未チェック。潜在的過剰権限。 | 不明/期限切れ時の安全側デフォルトを`share`(or無効)に。両関数でTTL確認。 |

### ⚪ Low
- A12 `LeftPanel.tsx:1018` — 応答を無条件`JSON.parse`。非JSON(HTML 5xx)で本エラー消失。`r.ok`+content-type判定追加。
- A13 `worker/index.ts:161-168` — Gemini `imageConfig`を旧`gemini-2.5-flash-image`にも送信→400可能性。モデル対応で分岐。
- A14 `DebugViewer.tsx:488-495` — FOVスライダーが先頭視点の📷保存で巻き戻る（`fovSeed`結合）。編集中はseed再適用を抑止。
- A15 `store/scene-store.ts:393-396` — 🏁初期視点削除で`startViewpointId`がdanglingのまま。削除時にnullクリア+UI通知。
- A16 `VRThumbPreview`(`target`) と `setViewpointYaw`(`mapYaw`) — VR視点の向きが二重ソースで恒久不一致。→ Part C で統合。
- A17 `camera-controller.ts:601-632` — `reacquireFloorHeight`がeyeより上の床を拾えず埋まる。
- A18 `MobileJoystick.tsx:134` (lint `react-hooks/refs`) — render中にref参照でtransitionがstale。

### 🧹 Lint（機能影響なし・掃除枠）
- `no-unused-vars` ×27（`orbit-camera-controller.ts` 11 / `three-scene-manager.ts` 9 が主）
- `exhaustive-deps` ×6・`set-state-in-effect` ×6（**無限ループは調査済で発生せず**。旧dev.logの「Maximum update depth」1万件は当時の別事象で現行コードに再現要因なし）
- `no-explicit-any` ×5・`preserve-manual-memoization` ×2
- 削除済コリジョン自動生成コードへの残存参照は無し（クリーン）。

---

## Part B — 新機能要件

### B1. タグ/ピンの配置がずれる → 移動・設定しやすく
**現状**: `ScenePin.placements[].position`(world XYZ) にプレビュー上のドラッグ+X/Y/Zナッジで配置。ドラッグ開始基準ズレは 9479b41 で一部修正済だが、視点移動・再描画でタグの見かけ位置がずれる訴え。
**やりたい**: タグの配置・微調整をもっと直感的・安定に。
**実装方針**:
- ドラッグ中のヒットは「3Dレイキャスト→splat/collisionメッシュ表面にスナップ」させ、奥行き(Z)を自動決定（現状は平面ドラッグで奥行きが曖昧になりやすい）。A3 のファントムクリック対策と同じ`dragRef`方式で掴み位置を安定化。
- 数値パネルにワールド系だけでなく「視点ローカル（左右/上下/前後 m）」入力も追加すると微調整が直感的。
- 複数配置の一覧に「この視点で見えている配置だけ表示」フィルタ（既に`viewpointId`束縛あり）を明示 UI 化。
- ⚠ 書き込みは`updatePinPlacement`経由で`placements[].position`のみ（target/live camera 不変）。

### B2. コリジョン（壁）を自動 / 手動で作れるように
**現状**: 自動生成(splat-transform voxel pipeline)は beb6072 で**撤去済**。今は手動GLBアップロードのみ。`CollisionConfig`は`source:'manual'|'auto'`と`manual*`/`auto*`スタッシュを既に持つ（＝両立前提の型は残っている）。
**やりたい**: 未設定の今、自動でも手動でも壁を作れるように。
**実装方針（2系統）**:
- **自動**: splat点群から床/壁を再生成。撤去した`gen-collision-browser.ts`をブラウザWASM(`@playcanvas/splat-transform` v2.6 の `-K`)で復活 or dev はCLI子プロセス（memory `collision_pipeline`参照）。出力を`autoWalkable`/`autoBlock`へ、`source='auto'`。
- **手動**: 図面(FloorPlan)上で壁線を引く簡易エディタ。線分→高さ押し出しでGLB(box)生成→`manualBlock`。床は図面外周ポリゴン→`manualWalkable`。図面は既に`worldToImage`変換を持つので線分のimage座標→world変換で建てられる。
- `source`トグルで自動/手動を切替（型は対応済、UI とローダ結線が必要）。顧客ビューアでは緑箱非表示（`collisionVisible`既定false）を維持。
- ⚠ このプロジェクトは今コリジョン未設定なので、**B2 は B3〜B6（ウォークスルー）の前提**（歩行には床が要る）。優先実装。

### B3〜B6. パノラマ・ウォークスルー（密グリッド移動）※VR 360°モード専用
> ユーザー要望の #3〜#6 は本質的に**1つの機能**。「100枚超のパノラマをグリッド配置し、向いている方向へ前進すると隣接ノードへ（アニメ付きで）移動して“歩いてる感じ”を出す」= Matterport / ストリートビュー型ナビ。
>
> **重要: これは VR 360°モードの機能。GS(splat)とは無関係な別モード。** パノラマは実写等の外部 360°画像で、各ノードに手動で割り当てる（splat からのレンダは一切しない）。GS モードの歩行(B2コリジョン)とはコード経路も別。

**要望の分解**:
- B3: VRで**アニメーション付き移動**。ON/OFF切替あり（OFF=即時スワップ）。
- B4: 画像がパッと切り替わるのでなく**歩いて移動している感覚**。
- B5: VRで**100枚以上**のパノラマを切替えて細かく動く。
- B6: グリッド `AA AB AC / BA BB BC / CA CB CC`。BBで180°向いて前進→BC、その状態で180°→CC…という**向いている方向を軸にした隣接移動**。

**現状の構造的課題**（→ Part C で修正）:
1. `Plan.panoramas: Record<viewpointId,string>` は100枚超でもマップとしては耐えるが、**グリッド座標も隣接関係も持たない**。「向き→隣ノード」を解けない。
2. `Viewpoint` が「curatedツアー停留所（シーン一覧に出す）」と「空間サンプル点」を兼任。100点をシーン一覧に並べるとUI破綻（B1のタブずれ問題も悪化）。→ **ウォークスルー用ノードを別概念に分離すべき**。
3. パノラマ切替は現状ハードスワップ（`equirect-skybox` 張替え、クロスフェード無し）。→ B3/B4 の演出が未実装。

**実装方針**（データ構造は Part C 参照）:
- **移動判定**: 現ノードで、現在の yaw に最も近い方位(bearing)を持つ隣接ノードを選び、前進入力でそこへ遷移。BB→(yawが東)→BC、BB→(yawが南)→CB のように**向いた方向へ1歩**。
- **アニメ遷移(ON)**: 遷移元/先の2枚のequirectを短時間クロスフェード＋進行方向へ軽くドリーズーム(FOV/カメラ前進)して前進感を出す。OFF=即張替え（現挙動）。切替トグルはビューア下部 or `SceneSettings`。
- **パノラマ = 外部360°画像を手動割り当て（自動生成はしない）**: 一様な自動グリッドは壁/家具の中に点が落ちて後修正が地獄になるため不採用。**作者が下部の図面グリッドエディタ（→ C7）でノードを1点ずつ置く/掴んで動かし、各ノードに 360°画像を割り当てる**（`WalkNode.panorama` にアップロード/選択）。100枚の実写360°を撮影→図面上の対応位置に手で配置、が基本ワークフロー。splat は無関係。
- ⚠ mapYaw 不変維持: ノード遷移でカメラ位置は動くが、**向き**は現在の live yaw を引き継ぐだけ。authored `mapYaw` は触らない。

---

## Part C — データ構造の評価と修正提案（「構造がおかしければ直す」）

### C1. 診断: 現構造はグリッド・ウォークスルーに合っていない
- `Viewpoint` は position/target/mapPosition/mapYaw を持つ**リッチな curated 停留所**。100点の密サンプルには重すぎ、かつ**隣接・グリッドの概念が無い**。
- `panoramas` は `viewpointId → url` の1層マップで、空間関係を表現できない。
- 結論: **curated viewpoints はそのまま**（ツアーの見どころ）残し、**密ウォークスルー用の軽量ノード層を新設**して分離する。二兎を1型で追うと B1 のタブUI破綻と A16 の二重ソース問題が悪化する。

### C2. 提案: `WalkGraph`（ウォークスルー・ノード層）を Plan に追加
```ts
/** 密ウォークスルー用の軽量ノード。curated Viewpoint とは別物。 */
export interface WalkNode {
  id: string;                 // 例 "BB"（グリッドラベル）や uuid
  /** グリッド座標（自動隣接判定に使う）。非グリッド配置なら省略可。 */
  cell?: { row: number; col: number };
  /** 実ワールド位置（3D）。パノラマを焼いた地点。 */
  position: Vec3;
  /** 図面ドット位置（省略時 position の XZ）。 */
  mapPosition?: Vec2;
  /** このノードに割り当てた外部360°画像（url / data / idb ref）。実写等。 */
  panorama: string;
  /**
   * 明示的な隣接（方位→ノードid）。省略時は cell から自動生成。
   * 方位はワールド系bearing（0=+Z,時計回り度）で解決。
   */
  neighbors?: Partial<Record<'N'|'E'|'S'|'W'|'NE'|'NW'|'SE'|'SW', string>>;
  /** パノラマの北向き補正（撮影時の機首方位）。方位→隣接の解決に使う。 */
  yawOffset?: number;
}

export interface WalkGraph {
  nodes: WalkNode[];
  /** グリッドの列/行→ラベル対応（"A","B","C"…）。ラベル生成/表示用。 */
  cols?: string[];
  rows?: string[];
  /** 開始ノード。省略時 nodes[0]。 */
  startNodeId?: string;
  /** 隣接の自動生成方式: 'grid4'|'grid8'|'manual'。 */
  adjacency?: 'grid4' | 'grid8' | 'manual';
}
```
`Plan` に追加:
```ts
export interface Plan {
  // …既存…
  /** 密パノラマ・ウォークスルー（B3〜B6）。curated viewpoints とは独立。 */
  walk?: WalkGraph;
}
```

### C3. ナビゲーション解決（向き→隣ノード）
```ts
// 現ノード currentNode と live camera yaw から、前進先ノードを選ぶ
function stepForward(node: WalkNode, yaw: number, g: WalkGraph): WalkNode | null {
  const neighbors = resolveNeighbors(node, g); // cell or neighbors から {bearing, id}[]
  // yaw に最も近い bearing の隣接を選択（閾値 ±45°以内）。無ければ null（壁）。
  let best = null, bestErr = 45;
  for (const nb of neighbors) {
    const err = Math.abs(angleDiff(yaw, nb.bearing));
    if (err < bestErr) { best = nb; bestErr = err; }
  }
  return best ? g.nodes.find(n => n.id === best.id) ?? null : null;
}
```
- BB(center) で yaw=東 → BC、yaw=南 → CB、yaw=180°回頭で反対隣接、と「向いた方向を軸に1歩」。要望 #6 と一致。
- `grid8` にすれば斜め(BB→CC)も可。要望の「BBで180°→BC、その状態で180°→CC」は連続ステップで表現。

### C4. アニメ遷移（B3/B4）
- `equirect-skybox` を**2枚保持**できるよう拡張（現状1枚張替え）。遷移中 old→new を uniform `blend` 0→1 でクロスフェード（~250–400ms）。
- 同時にカメラを進行方向へ僅かにドリー（or FOVを一瞬詰める）して前進感。`camera-controller` にノード間tween（position lerp）を追加。**mapYaw/target 不変**、yaw は現状維持。
- トグル: `SceneSettings.walkAnimated?: boolean`（既定true）。OFF=即張替え=現挙動。ビューア下部にも切替UI。

### C5. curated Viewpoint 側の整理（既存バグと接続）
- A16（VR視点の二重ソース）: `Viewpoint.target`(実入場向き) と `mapYaw`(図面コーン) の乖離は、curated視点では「図面コーンは表示専用」と割り切る現設計でOK。ただし **WalkNode 側は `target` を持たず yaw を live 継承**にすることで二重ソースを最初から作らない。
- 100点をシーン一覧に出さない: `walk.nodes` は専用の「ウォークスルー」タブ（グリッド表 UI）で管理し、`viewpoints` の シーン一覧とは分離。B1 のタブずれ／過密も回避。

### C6. マイグレーション / 後方互換
- `walk` は optional。既存シーンは未定義でも従来通り動く。
- 既存の per-viewpoint パノラマ（`panoramas[viewpointId]`）はそのまま。ウォークスルーは別レイヤなので競合しない。
- パノラマは**外部 360°画像を各ノードに手動割り当て**（自動生成なし）。既存の `equirect-skybox` 表示経路をそのまま使う。GS/splat・B2コリジョンとは無関係な別モード。

### C7. WalkGraph オーサリング UI（下部・図面＋グリッド）★要望の中核
**目的**: 100点超を「置きやすい・直しやすい」ようにする。Debug に「ウォークスルー」タブを追加し、**画面下部に図面＋グリッドのドックエディタ**を出す。
**レイアウト**:
- 下部ドック（高さ可変・折りたたみ可）に `plan.floorPlan.image` を表示。上に**グリッドオーバーレイ**を重ねる。
- グリッドは `walk.cols/rows`（列=A,B,C… 行=A,B,C…）とセル寸法(m)で定義。図面の既存 `worldToImage` 変換でセル↔world座標を対応。
**配置操作**:
- セルをクリック→そのセル中心に `WalkNode` 生成、`cell:{row,col}` と `position`(world) を自動セット、ラベルは列+行（例 `BC`）で自動採番。
- ノードは**ドラッグで微調整**。`スナップON`=最寄りセルに吸着 / `スナップOFF`=自由配置（cell は最寄りを保持）。掴み位置ズレは A3 と同じ `dragRef` 方式で防ぐ。
- 各ノードに **360°画像を割り当て**（ドロップ/選択でアップロード → `WalkNode.panorama`）。100枚を撮影順に一括アップロード→各セルへ割り当て、の運用も想定。
- 右クリック/選択で 削除・リネーム・画像差し替え。ツールバーに「グリッド行列変更」「隣接方式(grid4/grid8)」「スナップ切替」。
- Y はVR 360°なので `SceneSettings.cameraHeight`（アイレベル）固定でよい（床コリジョン不要）。
**隣接**:
- `walk.adjacency` に従い `cell` 隣接から自動生成（grid4/grid8）。壁で塞ぎたい辺は個別に `neighbors` から削除（手動オーバーライド）。
**プレビュー**:
- ノード選択でそのequirectをメインビューに表示。エディタ上で現在ノードをハイライトし、遷移テスト（前進で隣へ）をその場で確認。
- ⚠ 書き込みは `walk.nodes[]` のみ。curated `viewpoints`・`mapYaw`・live camera は不変。

---

## 実装順序の推奨
1. **A1/A2**（プラン切替コリジョン）— 歩行の土台。High。
2. **B2**（自動/手動コリジョン）— ウォークスルーの床が要る。
3. **C2/C3**（WalkGraph 型 + ナビ解決）— データ構造の芯。
4. **C7**（下部・図面グリッド オーサリングUI）— 手動配置＋360°画像割り当ての要。B5/B6 の運用はここで回す。
5. **C4 + B3/B4**（アニメ遷移 ON/OFF）。
6. 残りの Medium/Low バグ（A3〜A18）と B1（タグUX）を随時。

> 注: B3〜B6 は VR 360°モード（実写パノラマ）専用で GS(splat)非依存。よって B2(コリジョン)/A1/A2 の GS 歩行系とは独立して着手可能。GS 歩行を今すぐ使わないなら B3〜B6 → C7 を先行してもよい。

> fable5 への指示例: 「UPDATE_PLAN_fable5.md の A1 を実装して」等、番号で参照可能。各項目は場所・原因・方針が揃っているので単体で着手できる。
