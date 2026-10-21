@echo off
REM ===========================================================================
REM  Sinh "code graph" cho firmware bang Doxygen + Graphviz
REM  Chay file nay (nhay doi hoac go: tools\tao_code_graph.bat) tu thu muc goc
REM  Ket qua mo ra: docs\code_graph\html\index.html
REM ===========================================================================
setlocal
cd /d "%~dp0\.."

where doxygen >nul 2>nul
if errorlevel 1 (
    echo [LOI] Chua tim thay doxygen. Cai bang: winget install DimitriVanHeesch.Doxygen
    exit /b 1
)

REM Them Graphviz vao PATH cho phien chay nay neu chua co
set "PATH=%PATH%;C:\Program Files\Graphviz\bin"

echo Dang sinh code graph...
doxygen Doxyfile

echo.
echo Xong. Mo trang: docs\code_graph\html\index.html
start "" "docs\code_graph\html\index.html"
endlocal
