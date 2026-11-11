[Setup]
AppId=DeepInterviewLite.Installed
AppName=DeepInterview Lite
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\DeepInterview Lite
DefaultGroupName=DeepInterview Lite
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\DeepInterviewLite.exe
OutputDir={#ReleaseOutput}
OutputBaseFilename=DeepInterview-Lite-{#AppVersion}-Windows-x64
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#StageRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DeepInterview Lite"; Filename: "{app}\DeepInterviewLite.exe"; WorkingDir: "{app}"
Name: "{group}\User Guide"; Filename: "{app}\resources\app\docs\操作手册.md"

[Run]
Filename: "{app}\DeepInterviewLite.exe"; Description: "Launch DeepInterview Lite"; Flags: nowait postinstall skipifsilent
