' MusicFlow Backend — Silent Startup Script
' Runs server.py invisibly in the background (no console window)
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

pythonExe = "C:\Program Files\Python312\python.exe"
serverScript = "C:\Users\ssing\Downloads\music.sortcut\server\server.py"
workDir = "C:\Users\ssing\Downloads\music.sortcut\server"

' 0 = hidden window, False = don't wait for it to finish
objShell.Run """" & pythonExe & """ """ & serverScript & """", 0, False
