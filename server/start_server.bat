@echo off
title MusicFlow Backend Server
echo.
echo  ==========================================
echo   MusicFlow Backend — Starting...
echo   Keep this window open while listening!
echo  ==========================================
echo.
cd /d "%~dp0"
python server.py
pause
