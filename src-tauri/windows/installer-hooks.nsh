; Uninstall: "Delete the application data" also clears AioLM's data folders.
;
; Tauri removes only its own %APPDATA% and %LOCALAPPDATA% folders
; (com.aiolm.desktop). AioLM keeps its data in %USERPROFILE%\.aiolm, and
; earlier releases left data in %APPDATA%\aiolm and %LOCALAPPDATA%\aiolm, so
; the same choice clears those folders as well - except a "models" folder in
; them, which holds downloads the user may still want. A folder chosen with
; AIOLM_HOME is never removed, since the uninstaller cannot know what else it
; contains.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    !insertmacro AIOLM_DELETE_DATA_FOLDER "$PROFILE\.aiolm"
    !insertmacro AIOLM_DELETE_DATA_FOLDER "$APPDATA\aiolm"
    !insertmacro AIOLM_DELETE_DATA_FOLDER "$LOCALAPPDATA\aiolm"
  ${EndIf}
!macroend

; Removes everything in FOLDER except its "models" folder, then FOLDER itself
; once nothing is left in it.
!macro AIOLM_DELETE_DATA_FOLDER FOLDER
  Push $0
  Push $1
  FindFirst $0 $1 "${FOLDER}\*"
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
    ${AndIf} $1 != "models"
      RmDir /r "${FOLDER}\$1"
      Delete "${FOLDER}\$1"
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  RmDir "${FOLDER}"
  Pop $1
  Pop $0
!macroend
