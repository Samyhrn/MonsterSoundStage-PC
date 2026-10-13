@echo off
REM Monster SoundStage PC - lanceur Windows
REM Necessite Node.js installe (https://nodejs.org)
cd /d "%~dp0"
start "" http://localhost:8099
node server.js
