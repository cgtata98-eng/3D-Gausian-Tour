-- Headless test for Desktop\VrsceneExport.ms
-- NOT wrapped in ( ... ) — undeclared names inside a block become block-locals.
global v_root = @"C:\Users\takyu\AppData\Local\Temp\claude\C--Users-takyu\17ad4305-8e58-4115-bf66-1c990986005c\scratchpad\veout"
global v_fails = 0
global v_txt = ""

fn v_chk label cond = (
  if cond then format "PASS  %\n" label
  else ( format "FAIL  %\n" label; v_fails += 1 )
)

fn v_read path = (
  local f, s
  s = ""
  if doesFileExist path do (
    f = openFile path
    while not (eof f) do s += (readLine f) + "\n"
    close f
  )
  s
)

format "\n===== load =====\n"
global VE_NO_SHOW = true
try ( fileIn @"C:\Users\takyu\Desktop\VrsceneExport.ms" )
catch ( format "FAIL  load: %\n" (getCurrentException()) )

v_chk "VE_rollout compiled"      (VE_rollout != undefined)
v_chk "VE_sceneCameras defined"  (VE_sceneCameras != undefined)
v_chk "VE_writeCameraCsv defined"(VE_writeCameraCsv != undefined)
v_chk "VE_exportScene defined"   (VE_exportScene != undefined)
v_chk "VE_classReport defined"   (VE_classReport != undefined)

format "\n===== scene =====\n"
resetMaxFile #noPrompt
units.SystemType = #millimeters
units.SystemScale = 1.0
FreeCamera name:"CamB" pos:[1000,500,1500]
FreeCamera name:"CamA" pos:[0,0,1500]
-- Target camera: no `.rotation` property (LookAt controller) — must not throw.
TargetCamera name:"CamC" pos:[2000,0,1500] target:(Point pos:[2000,1000,1500])
global v_hasPhysical = false
try ( Physical name:"CamD" pos:[3000,0,1500]; v_hasPhysical = true ) catch ()
try ( TargetSpot name:"SomeLight" pos:[0,0,3000] ) catch ()
Box name:"NotACamera" pos:[0,0,0]

global v_cams = VE_sceneCameras()
global v_expect = if v_hasPhysical then 4 else 3
v_chk ("cameras found = " + (v_expect as string) + " (box + light + target helper excluded)") (v_cams.count == v_expect)
v_chk "sorted CamA, CamB, CamC" (v_cams.count >= 3 and v_cams[1].name == "CamA" and v_cams[2].name == "CamB" and v_cams[3].name == "CamC")
if v_hasPhysical do v_chk "Physical camera detected" (v_cams[4].name == "CamD")
v_chk "light not a camera" ((for c in v_cams where c.name == "SomeLight" collect c).count == 0)
v_chk "class report non-empty" ((VE_classReport()) != "")

format "\n===== camera CSV (SphereAlign format) =====\n"
makeDir v_root all:true
animationRange = interval 0 10
global v_msg = VE_writeCameraCsv (getNodeByName "CamC") (v_root + "\\t_cameras.csv") 0 10 2 1 "equirect"
format "  %\n" v_msg
v_chk "csv written" (doesFileExist (v_root + "\\t_cameras.csv"))

v_txt = v_read (v_root + "\\t_cameras.csv")
v_chk "header row"        ((findString v_txt "frame,image,px,py,pz,xx,xy,xz,yx,yy,yz,zx,zy,zz,fov_deg") != undefined)
v_chk "records camera"    ((findString v_txt "# camera: CamC") != undefined)
v_chk "records kind"      ((findString v_txt "# kind: equirect") != undefined)
v_chk "records units"     ((findString v_txt "# units: type=millimeters") != undefined)
v_chk "records renderer"  ((findString v_txt "# renderer:") != undefined)
v_chk "records axis note" ((findString v_txt "Z-up right-handed") != undefined)
v_chk "frame 0 -> image 1"((findString v_txt "\n0,1,") != undefined)
v_chk "step 2: frame 2 -> image 2" ((findString v_txt "\n2,2,") != undefined)
v_chk "step 2: frame 3 absent"     ((findString v_txt "\n3,") == undefined)
v_chk "last frame 10 -> image 6"   ((findString v_txt "\n10,6,") != undefined)
v_chk "target camera did not throw" ((findString v_msg "フレーム") != undefined)

format "\n===== scene export truthfulness =====\n"
-- 3dsmaxbatch defaults to Arnold, so vrayExportVRScene writes nothing and does
-- NOT throw. The tool must report that instead of claiming success.
global v_r = VE_exportScene (v_root + "\\t_scene.vrscene") false
format "  %\n" v_r
global v_wrote = doesFileExist (v_root + "\\t_scene.vrscene")
format "  file written: %\n" v_wrote
v_chk "message matches reality" \
  (if v_wrote then ((findString v_r "シーン: ") != undefined) \
   else ((findString v_r "シーン: ") == undefined))

format "\n===== RESULT: % failure(s) =====\n" v_fails
