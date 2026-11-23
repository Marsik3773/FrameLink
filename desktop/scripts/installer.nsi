!include "MUI2.nsh"
!include "x64.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FrameLink"
!define MUI_FINISHPAGE_RUN "$INSTDIR\FrameLink.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить FrameLink"

InstallDir "$LOCALAPPDATA\Programs\FrameLink"
RequestExecutionLevel user
ShowInstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Для FrameLink нужна 64-битная Windows."
    Abort
  ${EndIf}
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\FrameLink"
FunctionEnd

Section "FrameLink"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  SetCompress off
  File /oname=framelink.7z "${APP_64}"
  SetCompress auto
  SetOutPath "$INSTDIR"
  ClearErrors
  Nsis7z::Extract "$PLUGINSDIR\framelink.7z"
  IfErrors installation_failed
  IfFileExists "$INSTDIR\FrameLink.exe" 0 installation_failed
  IfFileExists "$INSTDIR\resources\app.asar" 0 installation_failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\FrameLink.lnk" "$INSTDIR\FrameLink.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "FrameLink"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\FrameLink.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  Goto installed

installation_failed:
  MessageBox MB_ICONSTOP "Не удалось установить FrameLink. Закройте приложение и повторите установку."
  SetErrorLevel 1
  Abort
installed:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs\FrameLink" 0 invalid_directory
  SetOutPath "$TEMP"
  Delete "$SMPROGRAMS\FrameLink.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
  Goto removed

invalid_directory:
  MessageBox MB_ICONSTOP "Папка FrameLink не найдена."
  SetErrorLevel 1
  Abort
removed:
SectionEnd
