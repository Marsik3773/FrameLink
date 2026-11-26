!include "MUI2.nsh"
!include "x64.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FrameLink"

InstallDir "$PROGRAMFILES64\FrameLink"
RequestExecutionLevel admin
ShowInstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro addLangs

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Для FrameLink нужна 64-битная Windows."
    Abort
  ${EndIf}
  StrCpy $INSTDIR "$PROGRAMFILES64\FrameLink"
FunctionEnd

Section "FrameLink"
  SetShellVarContext all
  SetRegView 64
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
  ClearErrors
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\repair-camera.ps1"' $0
  IfErrors camera_failed
  StrCmp $0 0 +2
  Goto camera_failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\FrameLink.lnk" "$INSTDIR\FrameLink.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "FrameLink"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\FrameLink.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  Goto installed

camera_failed:
  MessageBox MB_ICONSTOP "Не удалось зарегистрировать FrameLink Camera." /SD IDOK
  SetErrorLevel 2
  Abort

installation_failed:
  MessageBox MB_ICONSTOP "Не удалось установить FrameLink. Закройте FrameLink и приложения, использующие камеру." /SD IDOK
  SetErrorLevel 1
  Abort
installed:
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  StrCmp "$INSTDIR" "$PROGRAMFILES64\FrameLink" 0 invalid_directory
  SetOutPath "$TEMP"
  ExecWait '"$INSTDIR\resources\framelink-camera-register.exe" --remove'
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s /u "$INSTDIR\resources\FrameLinkMediaSource.dll"'
  Delete "$SMPROGRAMS\FrameLink.lnk"
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s /u "$INSTDIR\resources\FrameLinkCamera-x64.dll"'
  ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /s /u "$INSTDIR\resources\FrameLinkCamera-x86.dll"'
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
  Goto removed

invalid_directory:
  MessageBox MB_ICONSTOP "Папка FrameLink не найдена." /SD IDOK
  SetErrorLevel 1
  Abort
removed:
SectionEnd
