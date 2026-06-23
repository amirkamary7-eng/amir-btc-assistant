@echo off
setlocal enabledelayedexpansion
cd /d d:\amir-btc-assistant

REM Read index.html
for /f "usebackq delims=" %%A in ("index.html") do (
  set "line=%%A"
  if "!line!"=="</body>" (
    type modal-inject.html
    echo.
  )
  echo !line!
)>index_new.html

move /y index_new.html index.html
echo Modal added successfully
