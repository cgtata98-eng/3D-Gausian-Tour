/*
  export-walk-track.ms — 360°動画ウォークスルー用のカメラ軌跡書き出し

    VR_exportWalkTrack()          -- 選択カメラの軌跡を <root>\walk-track.json へ
    VR_exportWalkTrack cam:$Cam01 -- カメラを名前で指定
    VR_exportDoors()              -- 選択オブジェクトの位置を doors として追記

  なぜ書き出すのか
  ────────────────
  ビューア側は動画から位置を推定しない。equirect・低テクスチャの室内・歩行ブレという
  条件では SfM も光学フローも精度が出ず、床のポイントもドアも当てずっぽうになる。
  CG なら軌跡は既知なので、推定せずに持ってくる。

  取り込むと各ノードの視点に実座標が入り、床ポイントの向き・間隔も、図面のドットも、
  既存の経路がそのまま正しく動く。

  出力 (Debug の「カメラ軌跡を読む」がこの形を読む):
    {
      "fps": 30,
      "unitScale": 0.01,          -- Max が cm のとき。m に直す係数
      "startFrame": 0,
      "samples": [[x, y, z, yaw], ...],   -- フレーム 0 から連続
      "doors": [{ "name": "Door_Entrance", "pos": [x, y, z] }]
    }

  座標系
  ──────
  ビューアは PlayCanvas 準拠 (Y-up, yaw 0 = -Z 向き, 反時計回りが正)。
  Max は Z-up なので、ここで (x, z, -y) に組み替えて書き出す。読み込み側では
  変換しない ― 変換を 2 か所に置くと、どちらが正か分からなくなる。
*/

global VR_exportWalkTrack, VR_exportDoors

-- レンダールート。vantage-export.ms と揃えること。
global VR_RENDER_ROOT
if VR_RENDER_ROOT == undefined do VR_RENDER_ROOT = @"C:\render"

fn VR_wt_jsonNum v = (
  -- 小数点以下 4 桁。これ以上細かくしても位置の精度には効かないし、
  -- 数分ぶんのサンプルだとファイルだけ膨らむ。
  formattedPrint v format:".4f"
)

/* Max (Z-up) → ビューア (Y-up)。位置と向きを同時に組み替える。 */
fn VR_wt_sample cam frameNum = (
  at time frameNum (
    local p = cam.transform.position
    -- Z-up → Y-up
    local x = p.x
    local y = p.z
    local z = -p.y

    -- カメラの前方向 (Max のカメラは -Z を向く)
    local dir = -(normalize cam.transform.row3)
    local dx = dir.x
    local dz = -dir.y
    -- PlayCanvas の yaw: 0 = -Z 向き、反時計回りが正 → atan2(-dx, -dz)
    local yaw = atan2 (-dx) (-dz)
    if yaw < 0 do yaw += 360.0

    #(x, y, z, yaw)
  )
)

fn VR_exportWalkTrack cam:unsupplied outFile:unsupplied = (
  local c = if cam == unsupplied then (
    if selection.count == 1 and (isKindOf selection[1] camera) then selection[1] else undefined
  ) else cam

  if c == undefined do (
    format "[walk-track] カメラを 1 つ選択してから実行してください\n"
    return false
  )

  local out = if outFile == unsupplied then (VR_RENDER_ROOT + @"\walk-track.json") else outFile
  local s = animationRange.start as integer
  local e = animationRange.end as integer
  local fps = frameRate

  -- Max のフレームは ticks 単位。整数フレームで舐める。
  local sPerFrame = ticksPerFrame
  local first = s / sPerFrame
  local last = e / sPerFrame

  format "[walk-track] % : frame % - % @ % fps\n" c.name first last fps

  local f = createFile out
  if f == undefined do (
    format "[walk-track] 書き出せません: %\n" out
    return false
  )

  format "{\n" to:f
  format "  \"source\": \"%\",\n" (c.name) to:f
  format "  \"fps\": %,\n" fps to:f
  -- Max の単位を m に直す係数。システム単位から求める。
  local scale = (units.decodeValue "1m")
  format "  \"unitScale\": %,\n" (VR_wt_jsonNum (1.0 / scale)) to:f
  format "  \"startFrame\": %,\n" first to:f
  format "  \"samples\": [\n" to:f

  local n = 0
  for fr = first to last do (
    local v = VR_wt_sample c (fr * sPerFrame)
    format "    [%,%,%,%]" (VR_wt_jsonNum v[1]) (VR_wt_jsonNum v[2]) (VR_wt_jsonNum v[3]) (VR_wt_jsonNum v[4]) to:f
    if fr < last do format "," to:f
    format "\n" to:f
    n += 1
  )

  format "  ]\n}\n" to:f
  close f
  format "[walk-track] % サンプルを書き出しました → %\n" n out
  true
)

/*
  ドアなど「そこに貼りたいもの」の位置。
  選択したオブジェクトのピボットを書き出す。ビューア側は方向ではなく実座標で
  持つので、どこから見ても同じ場所に貼り付く。
*/
fn VR_exportDoors outFile:unsupplied = (
  if selection.count == 0 do (
    format "[walk-track] ドアにしたいオブジェクトを選択してから実行してください\n"
    return false
  )
  local out = if outFile == unsupplied then (VR_RENDER_ROOT + @"\walk-doors.json") else outFile
  local f = createFile out
  if f == undefined do (
    format "[walk-track] 書き出せません: %\n" out
    return false
  )
  local scale = (units.decodeValue "1m")
  format "{\n  \"unitScale\": %,\n  \"doors\": [\n" (VR_wt_jsonNum (1.0 / scale)) to:f
  for i = 1 to selection.count do (
    local o = selection[i]
    local p = o.transform.position
    format "    { \"name\": \"%\", \"pos\": [%,%,%] }" o.name (VR_wt_jsonNum p.x) (VR_wt_jsonNum p.z) (VR_wt_jsonNum (-p.y)) to:f
    if i < selection.count do format "," to:f
    format "\n" to:f
  )
  format "  ]\n}\n" to:f
  close f
  format "[walk-track] ドア % 件を書き出しました → %\n" selection.count out
  true
)

format "[walk-track] 読み込み完了。VR_exportWalkTrack() / VR_exportDoors() が使えます\n"
