/*
  VR Panorama Export — 3ds Max ツールウィンドウ

  使い方:
    このファイルを 3ds Max のビューポートにドラッグ&ドロップ、または
      fileIn @"C:\Users\takyu\Desktop\3D_CG_GS\scripts\render\vantage-tool.ms"

    ツールバーに置く場合:
      一度実行すると Customize > Toolbars のカテゴリ "VR Panorama" に
      "VR Panorama Export" が登録されるので、ボタンをドラッグする。

  vantage-export.ms / export-set.ms を読み込んで、その関数を呼ぶだけのラッパー。
  設定 (出力先 / 単位 / プレフィクス) は ini に保存され、次回も残る。

  MAXScript note: `local` はブロックの先頭にしか書けない。途中に置くと
  「先頭行にローカル宣言がありません」でコンパイルエラーになるので、
  このファイルでは全ハンドラで local を先頭にまとめている。
*/

global VR_TOOL_DIR = getFilenamePath (getSourceFileName())
global VR_TOOL_INI = (getDir #userScripts) + "\\vr_panorama_tool.ini"
global VR_panoTool

-- 古いダイアログは、ロールアウトを再定義する「前」に閉じる。あとで閉じようとしても
-- VR_panoTool は既に新しい定義に差し替わっており、画面に出ている古いダイアログを
-- 掴めない = スクリプトを更新したのに古い UI が残り続ける。
try ( destroyDialog VR_panoTool ) catch ()

-- Unit presets: label -> metres per system unit. The pipeline stores raw Max
-- coordinates and converts once on import, so this only has to be right here.
global VR_TOOL_UNITS = #("mm (0.001)", "cm (0.01)", "m (1.0)", "inch (0.0254)")
global VR_TOOL_UNIT_VALUES = #(0.001, 0.01, 1.0, 0.0254)

/* 依存スクリプトは毎回読み直す。
   「もう読んである」ガードを付けていたが、Max のセッションに前の版が残っていると
   新しい版が読み込まれず、あとから増えた関数が undefined のままロールアウトに
   束縛されて「呼び出しには関数かクラスが必要です」で落ちる。
   fileIn 2 本は一瞬なので、常に最新であることを優先する。
   読み直すと VR_RENDER_ROOT 等がファイル既定に戻るため、呼び出し側は直後に
   applySettings() で UI の値を書き戻すこと。 */
fn VR_toolLoadDeps force:true = (
  fileIn (VR_TOOL_DIR + "vantage-export.ms")
  fileIn (VR_TOOL_DIR + "export-set.ms")
)

fn VR_toolGet key default = (
  local v
  v = getINISetting VR_TOOL_INI "settings" key
  if v == "" then default else v
)

fn VR_toolSet key value = ( setINISetting VR_TOOL_INI "settings" key (value as string) )

-- ── Bind the pipeline globals BEFORE the rollout is compiled ────────────────
--
-- MAXScript binds a name used inside a rollout, but not declared as a global,
-- to a rollout-LOCAL variable. If these are not globals by the time the rollout
-- below is compiled, then inside the handlers:
--   - VR_viewpointCameras() calls `undefined`  → "呼び出しには関数かクラスが必要です"
--   - VR_RENDER_ROOT = etRoot.text  writes a rollout-local, so the export
--     functions never see the folder the user picked (silent, worse)
-- Loading the dependencies here — before the rollout — makes them real globals;
-- the explicit declarations keep the binding correct even if a load fails.
VR_toolLoadDeps()

global VR_RENDER_ROOT, VR_CAM_PREFIX, VR_UNIT_SCALE, VR_RENDER_CAM_NAME
global VR_viewpointCameras, VR_allCameras, VR_nodeIdFor, VR_sanitizeId, VR_buildRenderCamera
global VR_exportCameras, VR_exportSet, VR_exportVrscenes

-- タイトルにバージョンを入れてあるので、更新が反映されているか一目で分かる
rollout VR_panoTool "VR Panorama Export  v3 (2026-08-14)" width:430 (
  local logLines = #()

  group "出力先 / 設定" (
    edittext etRoot "" width:320 align:#left across:2
    button btBrowse "参照..." width:75 align:#right
    dropdownlist ddUnit "システム単位" items:VR_TOOL_UNITS width:175 align:#left across:2
    edittext etPrefix "カメラ接頭辞" text:"VR_" width:175 align:#right
    label lbPrefixHint "空欄にするとシーン内の全カメラを対象にします" align:#left
  )

  group "視点カメラ (名前順 = フレーム番号)" (
    listbox lbCams "" height:7 width:400
    label lbCount "cameras: -" align:#left across:2
    button btRefresh "再読込" width:90 align:#right
  )

  group "1. カメラを書き出す (1度だけ)" (
    checkbox cbCamVrscene "cameras.vrscene も書き出す" checked:true align:#left
    button btCams "cameras.json / .csv / .vrscene を書き出す" width:400 height:26
  )

  group "2. シーンを書き出す" (
    edittext etSet "セット名" text:"test01" width:245 align:#left across:2
    button btSet "このセットを書き出す" width:155 align:#right
    button btAll "render-plan.ms の全状態を書き出す" width:400 height:26
  )

  group "3. Node 側" (
    button btCopyPlan "render:plan をコピー" width:196 align:#left across:2
    button btCopyRun "render:run をコピー" width:196 align:#right
    button btOpen "出力フォルダを開く" width:196 align:#left across:2
    button btReload "スクリプト再読込" width:196 align:#right
  )

  label lbStatus "" align:#left height:16
  listbox lbLog "ログ" height:6 width:400

  fn say msg = (
    append logLines (msg as string)
    if logLines.count > 200 do deleteItem logLines 1
    lbLog.items = logLines
    lbLog.selection = logLines.count
    lbStatus.text = msg as string
    format "[VR tool] %\n" msg
  )

  fn applySettings = (
    VR_RENDER_ROOT = etRoot.text
    VR_CAM_PREFIX = etPrefix.text
    VR_UNIT_SCALE = VR_TOOL_UNIT_VALUES[ddUnit.selection]
    VR_toolSet "root" etRoot.text
    VR_toolSet "prefix" etPrefix.text
    VR_toolSet "unit" ddUnit.selection
    VR_toolSet "setName" etSet.text
  )

  fn refreshCams = (
    local cams, rows, i
    rows = #()
    VR_toolLoadDeps()
    VR_CAM_PREFIX = etPrefix.text
    cams = VR_viewpointCameras()
    for i = 1 to cams.count do
      append rows (((i - 1) as string) + "  " + (VR_nodeIdFor cams[i]) + "   (" + cams[i].name + ")")
    lbCams.items = rows
    lbCount.text = "cameras: " + (cams.count as string)
    cams
  )

  /* 0 台のとき、原因が「シーンにカメラが無い」のか「接頭辞で弾かれている」のかを
     はっきり言う。黙って空のリストを出すと、前と同じ壊れ方に見える。 */
  fn explainEmpty = (
    local all, names, n
    all = VR_allCameras()
    if all.count == 0 then (
      say "シーンにカメラがありません"
    ) else (
      n = amin all.count 5
      names = ""
      for i = 1 to n do names += all[i].name + "  "
      say ("接頭辞 '" + etPrefix.text + "' に一致するカメラが 0 台です")
      say ("シーンには " + (all.count as string) + " 台あります: " + names +
           (if all.count > n then "..." else ""))
      say "→ 接頭辞を空欄にすると全カメラが対象になります"
    )
  )

  -- 出力先が未設定のまま押されると、どこに書いたか分からないファイルが出来る。
  fn rootReady = (
    if etRoot.text == "" or not (doesFileExist etRoot.text) then (
      say ("出力先フォルダが未設定か存在しません: " + etRoot.text)
      false
    ) else true
  )

  on VR_panoTool open do (
    local cams
    etRoot.text = VR_toolGet "root" @"D:\vr_render"
    etPrefix.text = VR_toolGet "prefix" "VR_"
    etSet.text = VR_toolGet "setName" "test01"
    ddUnit.selection = (VR_toolGet "unit" "1") as integer
    VR_toolLoadDeps()
    applySettings()
    cams = refreshCams()
    say ("v3 2026-08-14  <- " + VR_TOOL_DIR + "vantage-tool.ms")
    if cams.count == 0 then explainEmpty()
    else say ("ready — " + (cams.count as string) + " cameras found")
  )

  on btBrowse pressed do (
    local p
    p = getSavePath caption:"レンダールートを選択" initialDir:etRoot.text
    if p != undefined do (
      etRoot.text = p
      applySettings()
      say ("root = " + p)
    )
  )

  on etPrefix changed txt do ( applySettings(); refreshCams() )
  on etRoot changed txt do ( applySettings() )
  on ddUnit selected i do ( applySettings(); say ("unitScale = " + (VR_TOOL_UNIT_VALUES[i] as string)) )

  on btRefresh pressed do (
    local c
    c = refreshCams()
    if c.count == 0 then explainEmpty() else say ((c.count as string) + " cameras")
  )

  on btCams pressed do (
    local cams
    if rootReady() do (
      applySettings()
      cams = refreshCams()
      if cams.count == 0 then (
        say ("カメラが見つかりません (接頭辞 " + etPrefix.text + ")")
      ) else (
        say "カメラを書き出し中..."
        VR_exportCameras vrscene:cbCamVrscene.checked
        say ("完了: cameras.json / .csv  (" + (cams.count as string) + " cameras)")
      )
    )
  )

  on btSet pressed do (
    if rootReady() do (
      applySettings()
      if etSet.text == "" then (
        say "セット名を入れてください"
      ) else (
        say ("'" + etSet.text + "' を書き出し中... (シーンが大きいと時間がかかります)")
        VR_exportSet etSet.text root:etRoot.text
        say ("完了: " + etRoot.text + "\\" + etSet.text)
      )
    )
  )

  on btAll pressed do (
    if rootReady() do (
      applySettings()
      if not (doesFileExist (etRoot.text + "\\render-plan.ms")) then (
        say "render-plan.ms がありません — 先に npm run render:plan を実行してください"
      ) else (
        say "全状態を書き出し中..."
        VR_exportVrscenes()
        say "完了 — 次は npm run render:run"
      )
    )
  )

  on btCopyPlan pressed do (
    local cmd
    cmd = "npm run render:plan -- " + (substituteString etRoot.text "\\" "/")
    setclipboardtext cmd
    say ("コピー: " + cmd)
  )

  on btCopyRun pressed do (
    local cmd
    cmd = "npm run render:run -- " + (substituteString etRoot.text "\\" "/")
    setclipboardtext cmd
    say ("コピー: " + cmd)
  )

  on btOpen pressed do ( if rootReady() do shellLaunch "explorer.exe" etRoot.text )

  on btReload pressed do (
    VR_toolLoadDeps force:true
    applySettings()   -- reload reset the globals to file defaults; put the UI values back
    refreshCams()
    say "vantage-export.ms / export-set.ms を再読込しました"
  )
)

-- 閉じる処理はファイル先頭で済ませてある（そこでないと古いダイアログを掴めない）
fn VR_showPanoramaTool = ( createDialog VR_panoTool 430 620 )

macroScript VR_PanoramaExport
  category:"VR Panorama"
  buttonText:"VR Panorama Export"
  tooltip:"VR Panorama Export (Vantage pipeline)"
(
  on execute do (
    local dir
    dir = getINISetting ((getDir #userScripts) + "\\vr_panorama_tool.ini") "settings" "toolDir"
    if (globalVars.isGlobal #VR_showPanoramaTool) == false then (
      if dir != "" and doesFileExist (dir + "vantage-tool.ms") then fileIn (dir + "vantage-tool.ms")
      else messageBox "vantage-tool.ms を一度 fileIn してください" title:"VR Panorama"
    ) else (
      VR_showPanoramaTool()
    )
  )
)

setINISetting VR_TOOL_INI "settings" "toolDir" VR_TOOL_DIR
-- VR_TOOL_NO_SHOW lets the headless smoke test (3dsmaxbatch) load this file to
-- verify it compiles and that the globals bind, without a UI to open.
if (globalVars.isGlobal #VR_TOOL_NO_SHOW) == false or VR_TOOL_NO_SHOW != true do
  VR_showPanoramaTool()
format "VR Panorama Export tool loaded (Customize > Toolbars > category 'VR Panorama')\n"
