-- Headless smoke test for the Vantage panorama pipeline scripts.
-- Run: 3dsmaxbatch.exe vr_test.ms -v 3 -listenerlog out.log
--
-- NOTE: deliberately NOT wrapped in ( ... ). Inside an anonymous code block,
-- MAXScript binds undeclared names to block-LOCALS, so every VR_* reference
-- would read `undefined` even after fileIn defines the globals — the same trap
-- that broke the rollout.

global t_base = @"C:\Users\takyu\Desktop\3D_CG_GS\scripts\render\"
global t_root = @"C:\Users\takyu\AppData\Local\Temp\claude\C--Users-takyu\17ad4305-8e58-4115-bf66-1c990986005c\scratchpad\vrout"
global t_fails = 0
global t_txt = ""

fn t_chk label cond = (
  if cond then format "PASS  %\n" label
  else ( format "FAIL  %\n" label; t_fails += 1 )
)

fn t_read path = (
  local f, s
  s = ""
  if doesFileExist path do (
    f = openFile path
    while not (eof f) do s += (readLine f) + "\n"
    close f
  )
  s
)

format "\n===== load (simulating a stale Max session) =====\n"
-- Pretend a PREVIOUS version of vantage-export.ms is already in memory: set the
-- sentinel the old guard checked, without ever loading the file. If the tool
-- skips loading on that basis, every function added since then binds to
-- `undefined` inside the rollout — which is exactly the crash this reproduces.
global VR_EXPORT_LOADED = true
global VR_EXPORTSET_LOADED = true

global VR_TOOL_NO_SHOW = true
try ( fileIn (t_base + "vantage-tool.ms") )   catch ( format "FAIL  vantage-tool.ms: %\n" (getCurrentException()) )
t_chk "stale session still gets the current export scripts" (VR_allCameras != undefined)

format "\n===== globals bound =====\n"
t_chk "VR_viewpointCameras defined"  (VR_viewpointCameras != undefined)
t_chk "VR_exportCameras defined"     (VR_exportCameras != undefined)
t_chk "VR_exportSet defined"         (VR_exportSet != undefined)
t_chk "VR_buildRenderCamera defined" (VR_buildRenderCamera != undefined)
t_chk "VR_exportVrscenes defined"    (VR_exportVrscenes != undefined)
t_chk "VR_panoTool rollout compiled" (VR_panoTool != undefined)

format "\n===== build scene =====\n"
resetMaxFile #noPrompt
FreeCamera name:"VR_AA" pos:[0,0,1500]
-- VR_AC is a TARGET camera on purpose: those have no `.rotation` property
-- (LookAt controller) and reading it throws. Most real scenes use them.
TargetCamera name:"VR_AC" pos:[2000,0,1500] target:(Point pos:[2000,1000,1500])
FreeCamera name:"VR_AB" pos:[1000,500,1500]
FreeCamera name:"NotAViewpoint" pos:[0,0,0]

VR_RENDER_ROOT = t_root
VR_CAM_PREFIX = "VR_"
VR_UNIT_SCALE = 0.001
makeDir t_root all:true

global t_cams = VR_viewpointCameras()
t_chk "3 viewpoint cameras (prefix filter)" (t_cams.count == 3)
t_chk "sorted AA, AB, AC" (t_cams.count == 3 and t_cams[1].name == "VR_AA" and t_cams[2].name == "VR_AB" and t_cams[3].name == "VR_AC")
t_chk "node id strips prefix" ((VR_nodeIdFor t_cams[1]) == "AA")

format "\n===== camera export =====\n"
VR_exportCameras vrscene:false
t_chk "cameras.json written" (doesFileExist (t_root + "\\cameras.json"))
t_chk "cameras.csv written"  (doesFileExist (t_root + "\\cameras.csv"))

t_txt = t_read (t_root + "\\cameras.json")
t_chk "json: index 0 = AA" ((findString t_txt "\"index\": 0, \"id\": \"AA\"") != undefined)
t_chk "json: index 2 = AC" ((findString t_txt "\"index\": 2, \"id\": \"AC\"") != undefined)
t_chk "json: NotAViewpoint excluded" ((findString t_txt "NotAViewpoint") == undefined)

t_txt = t_read (t_root + "\\cameras.csv")
t_chk "csv: header present" ((findString t_txt "maxFile,index,id,maxCamera") != undefined)
t_chk "csv: AB row present" ((findString t_txt ",1,AB,VR_AB,") != undefined)

format "\n===== render camera =====\n"
global t_rcam = VR_buildRenderCamera()
t_chk "render camera created" (t_rcam != undefined)
t_chk "animation range 0-2" (animationRange.start == 0f and animationRange.end == 2f)
if t_rcam != undefined do (
  at time 0 ( t_chk "frame 0 = VR_AA" (distance t_rcam.pos [0,0,1500] < 0.01) )
  at time 1 ( t_chk "frame 1 = VR_AB" (distance t_rcam.pos [1000,500,1500] < 0.01) )
  at time 2 ( t_chk "frame 2 = VR_AC" (distance t_rcam.pos [2000,0,1500] < 0.01) )
)
t_chk "render cam excluded from viewpoints" ((VR_viewpointCameras()).count == 3)

format "\n===== cameras that do NOT follow the naming convention =====\n"
-- Real scenes have cameras called "Camera 001" / "PhysCamera001". The prefix
-- filter hides them, and an empty prefix must take everything.
FreeCamera name:"Camera 001" pos:[9000,0,1500]
TargetCamera name:"PhysCamera001" pos:[9000,1000,1500] target:(Point pos:[9000,2000,1500])

VR_CAM_PREFIX = "VR_"
t_chk "prefix VR_ still finds only the 3" ((VR_viewpointCameras()).count == 3)
-- 6 = VR_AA, VR_AB, VR_AC, NotAViewpoint (also a camera), Camera 001, PhysCamera001.
-- VR_RENDER_CAM is excluded; it is generated, not a viewpoint.
t_chk "VR_allCameras sees all 6" ((VR_allCameras()).count == 6)

VR_CAM_PREFIX = ""
global t_all = VR_viewpointCameras()
t_chk "empty prefix takes every camera" (t_all.count == 6)
t_chk "generated render cam still excluded" \
  ((for c in t_all where c.name == "VR_RENDER_CAM" collect c).count == 0)
t_chk "id keeps the full name when no prefix" \
  ((for c in t_all where (VR_nodeIdFor c) == "PhysCamera001" collect c).count == 1)
t_chk "space in a camera name is made path-safe" \
  ((for c in t_all where (VR_nodeIdFor c) == "Camera_001" collect c).count == 1)

VR_CAM_PREFIX = "VR_"
delete (getNodeByName "Camera 001")
delete (getNodeByName "PhysCamera001")

format "\n===== rebuild is idempotent =====\n"
VR_buildRenderCamera()
t_chk "still 3 frames after rebuild" (animationRange.end == 2f)
t_chk "no duplicate render cam" ((for o in objects where o.name == "VR_RENDER_CAM" collect o).count == 1)

format "\n===== RESULT: % failure(s) =====\n" t_fails
