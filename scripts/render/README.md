# Vantage パノラマレンダーパイプライン

3ds Max で状態を作り、Chaos Vantage で描画し、Node でリネーム・変換するまでを自動化する。
**レンダリングは Vantage が行う。3ds Max は一切レンダーしない。**

## 全体像

```
3ds Max                          Node                        Vantage
────────                         ────                        ───────
VR_exportCameras()  ──→ cameras.json
                              ↓  npm run render:plan
                        render-plan.json  ←──────────── 唯一の正
                        render-plan.ms
                              ↓
VR_exportVrscenes() ──→ vrscene/*.vrscene
                              ↓  npm run render:run  ──→  localhost:20702
                        render/{node}/{node}_{state}.png  ←┘
                              ↓  npm run render:convert
                        web/{node}/*.jpg  → R2
```

## なぜフレーム番号でカメラを表すのか

Vantage の制御 API（`localhost:20702`）には **vrscene 内のカメラを列挙するコマンドも、
名前で選ぶコマンドも無い**。`startLiveLinkSequence` が受け取るのはフレーム範囲だけ。

そこで `VR_RENDER_CAM` という1台のカメラを、フレーム N で視点 N の位置へ瞬間移動する
ようにキーを打つ。**フレーム番号 = 視点 ID** となり、その対応表が `render-plan.json`。
Max 側のアニメーションもリネーム処理も同じ生成物を読むので、対応がズレようがない。

`vantage.temporal` は必ず `0`。有効だと前フレーム（＝別の部屋）のサンプルが再利用され、
一見きれいだが微妙に汚れた画が全枚数ぶん出来上がる。`plan.mjs` の検証で弾いている。

## 手順

### 0. 準備

- `render/states.config.json` を作る（`states.config.example.json` をコピー）
- `scripts/render/vantage-export.ms` の先頭 `VR_RENDER_ROOT` をレンダールートに合わせる
- 同ファイルの `VR_applyMat` / `VR_applyLight` / `VR_applyFurn` をシーンに合わせて実装する
  （レイヤー ON/OFF、マテリアルライブラリからの割当など）

### フォルダ構成

**カメラは全状態で共通なので、1度だけ別に書き出してルートに置く。** 状態ごとに書き出すと
同じものが12個でき、食い違っても気づけない。フレーム番号と視点IDの対応はこの配管で
唯一曖昧にできない部分なので、正が1つしかない形にしてある。

```
D:\vr_render\
  cameras.json            ← VR_exportCameras()  (plan.mjs が読む)
  cameras.csv             ← 同上（Excel で見る用。maxFile 列で出所が分かる）
  cameras.vrscene         ← 同上（レンダーカメラ1台のみ。参照用）
  states.config.json
  render-plan.json / .ms
  m01_day_on\
    m01_day_on.vrscene    ← VR_exportSet "m01_day_on"   (Vantage で開くのはこれ)
    m01_day_on.set.json   ← 中身と ../cameras.json への参照
  m01_day_night\
    ...
  render\AA\AA_m01_day_on.png ...
```

`states.config.json` の `vrscenePattern` を `"{state}/{state}.vrscene"` にすると
この構成のまま `render:run` が通る。

なお `cameras.vrscene` は参照・目視確認用で、`run.mjs` は読まない。**アニメーション付きの
レンダーカメラは各状態の vrscene の中にも入っている**（Vantage の API は開いたファイルから
フレーム範囲を描くだけで、別のカメラファイルを合成するコマンドが無いため）。

### GUI で操作する場合

`vantage-tool.ms` を 3ds Max にドラッグ&ドロップすればツールウィンドウが開く。
以下 1〜3 の Max 側の操作は全部ボタンで済む。

```maxscript
fileIn @"C:\Users\takyu\Desktop\3D_CG_GS\scripts\render\vantage-tool.ms"
```

- 出力先・システム単位・カメラ接頭辞はウィンドウ上で設定し、ini に保存される
- **視点カメラが「フレーム番号 + ノードID + カメラ名」の一覧で出る**ので、
  命名ミスや並び順の間違いを書き出す前に見つけられる
- `npm run render:plan` / `render:run` のコマンドをクリップボードにコピーするボタンつき
- 「スクリプト再読込」ボタンで `vantage-export.ms` / `export-set.ms` を Max 再起動なしに
  読み直せる（状態適用の関数を書きながら試すとき用）
- 一度実行すると Customize > Toolbars のカテゴリ **VR Panorama** に登録されるので、
  ツールバーにボタンを置ける

以降は同じ処理をリスナーから直接呼ぶ場合の手順。

### 1. カメラを書き出す（3ds Max、1度だけ）

視点カメラは `VR_AA` `VR_AB` … と `VR_` プレフィクスで命名する。名前順がフレーム順になる。

```maxscript
fileIn @"C:\Users\takyu\Desktop\3D_CG_GS\scripts\render\vantage-export.ms"
VR_exportCameras()               -- cameras.json + cameras.csv + cameras.vrscene
VR_exportCameras vrscene:false   -- データだけ（vrscene 書き出しを省く）
```

カメラを増減したらここからやり直す（`render:plan` の再実行も必要）。

### 2. 計画を生成する

```
npm run render:plan -- D:/vr_render
```

`render-plan.json`（Node 用）と `render-plan.ms`（Max 用）が同時に出る。
状態数 × カメラ数 = 総枚数がここで表示されるので、着手前に規模を確認できる。

### 3. vrscene を書き出す（3ds Max）

全状態をまとめて：

```maxscript
VR_exportVrscenes()
```

1状態だけ（最初の1回、テスト用）：

```maxscript
fileIn @"C:\Users\takyu\Desktop\3D_CG_GS\scripts\render\export-set.ms"
VR_exportSet "m01_day_on"
```

どちらも状態ごとに軸の値を適用して vrscene を書き出す。既存ファイルはスキップするので
途中で止めても再実行できる。**この段階ではレンダーしないので数分で終わる。**

### 4. レンダーする（Vantage を起動しておくこと）

```
npm run render:run -- D:/vr_render
npm run render:run -- D:/vr_render --dry            # 何が実行されるかだけ確認（書き込まない）
npm run render:run -- D:/vr_render --only=m01_day_on
npm run render:run -- D:/vr_render --force          # 完了済みも再レンダー
```

Vantage アプリ本体が起動している必要がある（`vantage_console.exe` はこの API を提供しない）。

**中断からの再開**が二重に効く。`render-plan.json` の `states[].status` と、出力画像が
既に全部存在するかの実チェック。夜中に落ちても再実行すれば続きから始まる。

進捗はフレーム数のポーリングで判定している（`getStatus` のレスポンス形式は非公開のため）。
実行ログに `status:` の生レスポンスが状態ごとに1回出るので、形式が判明したら
`run.mjs` の待機処理を短縮できる。

### 5. web 用に変換する

```
npm run render:convert -- stills D:/vr_render --format=jpg --quality=3
npm run render:convert -- stills D:/vr_render --format=webp --width=4096
```

PNG マスターは残るので、後から画質や形式を変えても**再レンダーは不要**。

### 6. パノラマ動画（扉の開閉など）

扉が開くアニメーションを1本レンダーすれば、閉じる方は逆順エンコードで作れる。

```
npm run render:convert -- video D:/vr_render/door_frames D:/vr_render/video door --fps=30
→ door_open.mp4 / door_close.mp4
```

`-vf reverse` は使っていない。あれは全フレームを非圧縮でメモリに積むため、4K equirect
では数GB必要になって落ちる。concat デマルチプレクサに逆順のリストを渡せば追加コストゼロ。

動画側は連続したカメラなので、こちらは `temporal: 1` でレンダーしてよい（静止画の
テレポートカメラとは逆）。

## ファイル

| ファイル | 役割 |
|---|---|
| `smoke-test.ms` | 3ds Max: ヘッドレス回帰テスト（下記） |
| `vantage-tool.ms` | 3ds Max: ツールウィンドウ（下の 2 本のラッパー。ツールバー登録可） |
| `vantage-export.ms` | 3ds Max: カメラ書き出し（1度だけ）/ 状態適用 / 全状態の vrscene |
| `export-set.ms` | 3ds Max: 1状態ぶんの vrscene をセット名フォルダに（テスト・追加用） |
| `plan.mjs` | `render-plan.json` + `render-plan.ms` の生成と検証 |
| `vantage.mjs` | Vantage localhost:20702 クライアント |
| `run.mjs` | 状態ループ・進捗監視・リネーム・再開 |
| `ffmpeg.mjs` | 静止画変換 / 連番→mp4（順・逆） |
| `convert.mjs` | `ffmpeg.mjs` の CLI |

ffmpeg は PATH 上のものを使う。別の場所にあるときは環境変数 `FFMPEG_PATH` で指定する。

## MAXScript の回帰テスト

3ds Max を開かずに `.ms` 3本を検証できる。ダミーカメラを作って
cameras.json / cameras.csv の中身とテレポートカメラのキーまで確認する。

```
& "C:\Program Files\Autodesk\3ds Max 2026\3dsmaxbatch.exe" `
  "C:\Users\takyu\Desktop\3D_CG_GS\scripts\render\smoke-test.ms" `
  -v 3 -listenerlog "$env:TEMP\vr_listener.log"
Get-Content "$env:TEMP\vr_listener.log" | Select-String "PASS|FAIL|RESULT"
```

`.ms` を触ったら必ず流すこと。MAXScript は**コンパイル時に静かに壊れる**書き方が多く
（`local` の位置、ロールアウト内の未宣言名がローカルに落ちる、予約名）、目視では気づけない。

### 踏んだ罠

- **`local` はブロック先頭のみ。** 他の式の後に置くと「先頭行にローカル宣言がありません」。
  ファイル直下は「ブロック」ではないので、そこでも使えない
- **ロールアウト内で未宣言の名前はグローバルではなくロールアウトのローカルになる。**
  関数呼び出しは `undefined` になり、代入はグローバルに届かない（無症状で設定が無視される）。
  → 使う関数・変数は**ロールアウト定義より前に `global` 宣言**しておく
- 匿名コードブロック `( ... )` の中でも同じことが起きる（このテストが囲っていない理由）
- `ok` / `on` / `white` などは予約名

## 未検証の前提

- **パノラマ（360°）モードの保存先** — Vantage の API にカメラ種別を切り替えるコマンドは
  見当たらない。Vantage UI でパノラマに設定した状態が `openFile` した vrscene にも効くか、
  最初の1枚で必ず確認すること。効かないなら Max 側のカメラを球面カメラとして書き出す。
- **vrscene のサイズとロード時間** — 状態ごとに1個なので、大きいと合計が膨らむ。
  `vrayExportVRScene` の分割書き出しが Vantage で開けるかは未確認。
- **`getStatus` のレスポンス形式** — 非公開。現状は進捗判定に使っていない。
- ~~カメラのみ書き出しのキーワード~~ **解決**: `exportSelectionOnly:true` が正しい
  （`Desktop\vantageVRSceneExporter_ANIMATION.ms` で実績あり）。
